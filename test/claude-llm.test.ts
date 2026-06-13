/**
 * ClaudeLlm live smoke test — guarded so CI without a key stays green and the
 * suite stays deterministic on StubLlm. Runs only when ANTHROPIC_API_KEY is
 * set; otherwise skipped (no API call). Asserts the real content engine returns
 * non-empty prose grounded in the supplied canon text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CanonStore } from "../src/canon.ts";
import { ClaudeLlm, generateUnit } from "../src/engine.ts";

const KEY = process.env.ANTHROPIC_API_KEY?.trim();

test(
  "ClaudeLlm produces non-empty grounded exposition (live)",
  { skip: KEY ? false : "ANTHROPIC_API_KEY not set — skipping live API test" },
  async () => {
    const canon = new CanonStore();
    canon.put({
      doc_id: "web/john/1",
      version: "WEB",
      lang: "en",
      text: "1 In the beginning was the Word, and the Word was with God, and the Word was God.",
    });

    const unit = await generateUnit(
      { instruction: "Write a faithful exposition of web/john/1.", docIds: ["web/john/1"] },
      new ClaudeLlm(),
      canon,
    );

    assert.equal(typeof unit.body, "string");
    assert.ok(unit.body.trim().length > 0, "exposition must be non-empty");
    assert.equal(unit.source_refs[0]?.doc_id, "web/john/1");
  },
);
