/**
 * ClaudeTranslator live smoke test — the ONE network-touching test, guarded so
 * CI without a key stays green and the suite stays deterministic on
 * StubTranslator. It runs only when ANTHROPIC_API_KEY is set; otherwise it is
 * skipped (no API call). It asserts the real translator returns non-empty
 * text that differs from the English source.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeTranslator } from "../src/translate.ts";

const KEY = process.env.ANTHROPIC_API_KEY?.trim();

test(
  "ClaudeTranslator returns non-empty, different-language text (live)",
  { skip: KEY ? false : "ANTHROPIC_API_KEY not set — skipping live API test" },
  () => {
    const translator = new ClaudeTranslator();
    const source = "God is love.";
    const out = translator.translate(source, "en", "es");
    assert.equal(typeof out, "string");
    assert.ok(out.trim().length > 0, "translation must be non-empty");
    assert.notEqual(
      out.trim().toLowerCase(),
      source.toLowerCase(),
      "translation must differ from the English source",
    );
  },
);
