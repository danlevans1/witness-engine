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
