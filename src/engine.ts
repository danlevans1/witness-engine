/**
 * Content Engine scaffold.
 *
 * The LLM call is stubbed behind LlmClient. generateUnit grounds the
 * request in canon docs: it resolves each requested doc_id in the Canon
 * Store, passes the canonical text to the model, and stamps every
 * source_ref with the canon hash it was actually grounded against.
 *
 * Note: generateUnit refusing unknown doc_ids is a convenience for honest
 * callers — it is NOT the safety boundary. The verification pass
 * (verify.ts) independently re-checks every ref, so a buggy or malicious
 * engine cannot reach the publish queue.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CanonStore } from "./canon.ts";
import type { ContentUnit, SourceRef, UnitFormat } from "./types.ts";

/** The only surface a real model provider needs to implement. */
export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

/** Deterministic stub for step 1 — echoes a grounded summary shape. */
export class StubLlm implements LlmClient {
  async complete(prompt: string): Promise<string> {
    const firstLine = prompt.split("\n", 1)[0] ?? "";
    return `[stub] ${firstLine}`.trim();
  }
}

export interface GenerateRequest {
  instruction: string; // what to produce
  docIds: string[]; // canon docs to ground against
  format?: UnitFormat; // default "markdown"
}

export async function generateUnit(
  req: GenerateRequest,
  llm: LlmClient,
  canon: CanonStore,
): Promise<ContentUnit> {
  const refs: SourceRef[] = [];
  const grounding: string[] = [];
  for (const docId of req.docIds) {
    const doc = canon.get(docId);
    if (!doc) {
      throw new Error(`generateUnit: unknown canon doc ${docId}`);
    }
    refs.push({ doc_id: doc.doc_id, hash: doc.hash });
    grounding.push(`--- ${doc.doc_id} (${doc.version}, ${doc.lang}) ---\n${doc.text}`);
  }

  const body = await llm.complete(
    `${req.instruction}\n\nGround every claim in the following canonical texts. ` +
      `Do not cite anything outside them.\n\n${grounding.join("\n\n")}`,
  );

  return {
    unit_id: randomUUID(),
    source_refs: refs,
    body,
    format: req.format ?? "markdown",
  };
}

// --- Real content engine: Claude Messages API -------------------------------
// Scope discipline (mirrors ClaudeTranslator in src/translate.ts): this is for
// canon-grounded scripture exposition only. It takes the grounded prompt that
// generateUnit builds and returns publication-ready prose — it is NOT a
// general-purpose API surface. It implements the SAME LlmClient contract as
// StubLlm, so it drops into generateUnit with no other changes.

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudeLlmOptions {
  model?: string;
  maxTokens?: number;
}

export class ClaudeLlm implements LlmClient {
  readonly #model: string;
  readonly #maxTokens: number;

  constructor(opts: ClaudeLlmOptions = {}) {
    this.#model = opts.model ?? CLAUDE_MODEL;
    this.#maxTokens = opts.maxTokens ?? 4096;
  }

  async complete(prompt: string): Promise<string> {
    const apiKey = process.env[ANTHROPIC_API_KEY_ENV];
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new Error(
        `ClaudeLlm: missing ${ANTHROPIC_API_KEY_ENV}. Set the API key in the ` +
          `environment (it is never hard-coded or logged).`,
      );
    }

    const system =
      `You are a faithful, doctrinally-careful writer of scripture exposition. ` +
      `Write clear prose grounded ONLY in the canonical text provided in the user's ` +
      `message. Do not introduce claims, quotations, citations, or doctrines from ` +
      `anything outside that text. Stay faithful to the passage's meaning; do not ` +
      `speculate or embellish. Return ONLY the exposition prose suitable for ` +
      `publication — no preamble, headings, notes, or commentary about the task.`;

    const body = JSON.stringify({
      model: this.#model,
      max_tokens: this.#maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });

    // Mirrors ClaudeTranslator. SECURITY: the API key is passed ONLY through the
    // child's environment and referenced as $ANTHROPIC_API_KEY inside the shell —
    // it never appears in argv, on disk, or in any log. The prompt is piped via
    // stdin, so it never appears in argv either.
    let raw: string;
    try {
      raw = execFileSync(
        "sh",
        [
          "-c",
          `exec curl -sS -X POST ${ANTHROPIC_MESSAGES_URL} ` +
            `-H "x-api-key: $${ANTHROPIC_API_KEY_ENV}" ` +
            `-H "anthropic-version: ${ANTHROPIC_VERSION}" ` +
            `-H "content-type: application/json" ` +
            `--data-binary @-`,
        ],
        { input: body, encoding: "utf8", env: process.env, maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (e) {
      // curl's error text never contains the key (it lives only in the env).
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`ClaudeLlm: Anthropic API request failed: ${msg}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("ClaudeLlm: could not parse Anthropic API response");
    }
    const out = extractCompletion(parsed);
    if (out.trim() === "") {
      throw new Error("ClaudeLlm: Anthropic API returned an empty completion");
    }
    return out;
  }
}

function extractCompletion(parsed: unknown): string {
  const obj = parsed as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { type?: string; message?: string };
  };
  if (obj.error) {
    throw new Error(
      `ClaudeLlm: Anthropic API error: ${obj.error.message ?? obj.error.type ?? "unknown"}`,
    );
  }
  if (!Array.isArray(obj.content)) {
    throw new Error("ClaudeLlm: unexpected Anthropic API response shape");
  }
  return obj.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}
