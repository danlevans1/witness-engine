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
 * no network calls. A real Claude-API translator would implement the same
 * interface later — do NOT call any network API in v0.1.
 */

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
