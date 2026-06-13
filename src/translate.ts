/**
 * Step 3 — Tier 1 translation with a back-translation quality gate.
 *
 * Translation never bypasses publishing governance: a translated page is still
 * a gated publish (see publishTranslatedPage). This module only produces the
 * translated text and a quality score; whether anything reaches disk is still
 * the PFC gateway's decision.
 *
 * The model sits behind the `Translator` interface, mirroring Step 1's
 * LlmClient/StubLlm seam. `StubTranslator` is a deterministic, reversible
 * stand-in so the back-translation round-trip can be exercised both ways with
 * no network calls — it remains the default for tests. `ClaudeTranslator` is
 * the real, Claude-API-backed implementation of the SAME interface, swappable
 * in without touching the gate or the publish path.
 */
import { execFileSync } from "node:child_process";

export type Tier1Lang = "es" | "fr" | "pt";

/** Tier 1: Spanish, French, Portuguese. */
export const TIER1_LANGS: readonly Tier1Lang[] = ["es", "fr", "pt"] as const;

export function isTier1Lang(lang: string): lang is Tier1Lang {
  return lang === "es" || lang === "fr" || lang === "pt";
}

/** The only surface a real translation provider needs to implement. */
export interface Translator {
  /** Translate `text` from `fromLang` to `toLang`, returning the translation. */
  translate(text: string, fromLang: string, toLang: string): string;
}

// --- Deterministic stub -----------------------------------------------------
// A per-language Caesar shift: reversible, so en->X then X->en round-trips to
// the original exactly (clean score 1.0), while each language's output differs.
// This is a placeholder for a real translator, not a translation.

const LANG_SHIFT: Record<Tier1Lang, number> = { es: 1, fr: 2, pt: 3 };

function shiftFor(lang: string): number {
  return isTier1Lang(lang) ? LANG_SHIFT[lang] : 0;
}

function caesar(text: string, by: number): string {
  return text.replace(/[a-z]/gi, (ch) => {
    const base = ch <= "Z" ? 65 : 97;
    const n = (((ch.charCodeAt(0) - base + by) % 26) + 26) % 26;
    return String.fromCharCode(base + n);
  });
}

export interface StubTranslatorOptions {
  /**
   * Corrupt the back-translation (target->en) so the round-trip no longer
   * matches the source and the quality gate fails. Used to exercise the
   * "honest gap over bad coverage" path.
   */
  corruptBackTranslation?: boolean;
}

export class StubTranslator implements Translator {
  readonly #corrupt: boolean;

  constructor(opts: StubTranslatorOptions = {}) {
    this.#corrupt = opts.corruptBackTranslation ?? false;
  }

  translate(text: string, fromLang: string, toLang: string): string {
    if (toLang === "en") {
      // Back-translation (target -> English).
      if (this.#corrupt) return "lorem ipsum dolor sit amet";
      return caesar(text, -shiftFor(fromLang));
    }
    // Forward (English -> target).
    return caesar(text, shiftFor(toLang));
  }
}

// --- Back-translation quality gate ------------------------------------------

/** Moderate quality bar: a clean round-trip scores 1.0; corruption ~0. */
// Back-translation similarity floor for publishing a translation.
// Empirically grounded (not arbitrary): on WEB scripture, good Tier 1
// translations (es/fr/pt) round-trip at 0.99+ via Jaccard token overlap,
// while gross failures score ~0. 0.7 sits in the wide empty middle — it
// passes faithful translations and catches gross failures. It does NOT yet
// probe near-miss detection (plausible-but-subtly-wrong), because Tier 1
// round-trips don't land near it. Revisit when Tier 2/3 languages produce
// mid-band scores that actually exercise the threshold.
export const QUALITY_THRESHOLD = 0.7;

/** Normalize for comparison: NFC, lowercased, punctuation-stripped tokens. */
function normTokens(s: string): string[] {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

/** Token-overlap (Jaccard) similarity in [0,1]; case/whitespace-insensitive. */
export function similarity(a: string, b: string): number {
  const A = new Set(normTokens(a));
  const B = new Set(normTokens(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

export interface BackTranslationCheck {
  target: string; // forward translation (the would-be page body)
  back: string; // back-translation into English
  score: number; // similarity(source, back) in [0,1]
  threshold: number;
  pass: boolean;
}

/**
 * Translate source->target then target->source and score the round-trip
 * against the original English. Returns the forward translation too, so a
 * passing caller can publish exactly what was scored.
 */
export function backTranslationCheck(
  translator: Translator,
  source: string,
  toLang: string,
): BackTranslationCheck {
  const target = translator.translate(source, "en", toLang);
  const back = translator.translate(target, toLang, "en");
  const score = similarity(source, back);
  return { target, back, score, threshold: QUALITY_THRESHOLD, pass: score >= QUALITY_THRESHOLD };
}

// --- Real translator: Claude Messages API -----------------------------------
// Scope discipline: this is for canon-derived content only (public-domain WEB
// scripture). It takes text in and returns translated text out — it is NOT a
// general-purpose API surface. It implements the SAME synchronous Translator
// contract as StubTranslator, so it drops into the gate and publish path with
// no other changes.

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
};
function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export interface ClaudeTranslatorOptions {
  model?: string;
  maxTokens?: number;
}

export class ClaudeTranslator implements Translator {
  readonly #model: string;
  readonly #maxTokens: number;

  constructor(opts: ClaudeTranslatorOptions = {}) {
    this.#model = opts.model ?? CLAUDE_MODEL;
    this.#maxTokens = opts.maxTokens ?? 4096;
  }

  translate(text: string, fromLang: string, toLang: string): string {
    const apiKey = process.env[ANTHROPIC_API_KEY_ENV];
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new Error(
        `ClaudeTranslator: missing ${ANTHROPIC_API_KEY_ENV}. Set the API key in the ` +
          `environment (it is never hard-coded or logged).`,
      );
    }

    const system =
      `You are a faithful translator of public-domain scripture (the World English Bible). ` +
      `Translate the user's text from ${languageName(fromLang)} to ${languageName(toLang)}. ` +
      `Preserve meaning, verse numbers, and proper names. Return ONLY the translation — ` +
      `no preamble, notes, quotation marks, or commentary.`;

    const body = JSON.stringify({
      model: this.#model,
      max_tokens: this.#maxTokens,
      system,
      messages: [{ role: "user", content: text }],
    });

    // The Translator contract is synchronous, so the call blocks via curl.
    // SECURITY: the API key is passed ONLY through the child's environment and
    // referenced as $ANTHROPIC_API_KEY inside the shell — it never appears in
    // argv, on disk, or in any log. The request body (the canon text) is piped
    // via stdin, so it never appears in argv either.
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
      throw new Error(`ClaudeTranslator: Anthropic API request failed: ${msg}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("ClaudeTranslator: could not parse Anthropic API response");
    }
    const out = extractTranslation(parsed);
    if (out.trim() === "") {
      throw new Error("ClaudeTranslator: Anthropic API returned an empty translation");
    }
    return out;
  }
}

function extractTranslation(parsed: unknown): string {
  const obj = parsed as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { type?: string; message?: string };
  };
  if (obj.error) {
    throw new Error(
      `ClaudeTranslator: Anthropic API error: ${obj.error.message ?? obj.error.type ?? "unknown"}`,
    );
  }
  if (!Array.isArray(obj.content)) {
    throw new Error("ClaudeTranslator: unexpected Anthropic API response shape");
  }
  return obj.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}
