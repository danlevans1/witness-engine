/**
 * translate-demo — observe REAL Claude translation quality scores so the
 * QUALITY_THRESHOLD can be tuned against actual data.
 *
 * It takes one seeded canon unit, runs it through ClaudeTranslator and the
 * back-translation gate for each Tier 1 language (es, fr, pt), and prints the
 * similarity score and pass/fail against QUALITY_THRESHOLD.
 *
 * This is an operator measurement tool. It does NOT publish anything and does
 * NOT go through the PFC gateway. It requires ANTHROPIC_API_KEY and fails
 * clearly without it. Each language makes two real API calls (forward + back).
 *
 *   ANTHROPIC_API_KEY=<your-key> node scripts/translate-demo.ts [doc_id]
 *   # default doc_id: web/matthew/5
 */
import { CanonStore } from "../src/canon.ts";
import {
  ANTHROPIC_API_KEY_ENV,
  ClaudeTranslator,
  QUALITY_THRESHOLD,
  TIER1_LANGS,
  backTranslationCheck,
} from "../src/translate.ts";

function main(): void {
  const key = process.env[ANTHROPIC_API_KEY_ENV];
  if (key === undefined || key.trim() === "") {
    console.error(
      `translate-demo: ${ANTHROPIC_API_KEY_ENV} is not set. ` +
        `Export your Anthropic API key and retry.`,
    );
    process.exit(1);
  }

  const docId = process.argv[2] ?? "web/matthew/5";
  const canonPath = new URL("../data/canon.jsonl", import.meta.url).pathname;
  const canon = new CanonStore(canonPath);
  const doc = canon.get(docId);
  if (!doc) {
    console.error(`translate-demo: canon doc ${docId} not found (seed with: npm run seed)`);
    process.exit(1);
  }

  // Larger max_tokens than the library default, since a chapter round-trips.
  const translator = new ClaudeTranslator({ maxTokens: 8192 });

  console.log(
    `translate-demo: ${docId} (${doc.version}, ${doc.lang}), ` +
      `${doc.text.length} chars, threshold=${QUALITY_THRESHOLD}\n`,
  );

  for (const lang of TIER1_LANGS) {
    const check = backTranslationCheck(translator, doc.text, lang);
    const verdict = check.pass ? "PASS" : "FAIL";
    console.log(
      `en -> ${lang} -> en: score=${check.score.toFixed(3)}  ${verdict}  ` +
        `(threshold ${QUALITY_THRESHOLD})`,
    );
  }

  console.log("\n(no pages published — measurement only)");
}

main();
