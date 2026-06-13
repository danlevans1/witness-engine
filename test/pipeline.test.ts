/**
 * run-pipeline smoke test — exercises the operator runner end-to-end through
 * the REAL gateway and real functions, with NO API call and NO faking, now
 * including the human-review gate.
 *
 * English-only (langs: []), so no translation and no ANTHROPIC_API_KEY:
 * submit (StubLlm content) -> human approves via recordReview -> publish phase
 * publishes the approved unit through the gateway -> coverage written.
 * Deterministic (asserts outcomes/files, not random receipt ids).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

import { StubLlm } from "../src/engine.ts";
import { recordReview } from "../src/review.ts";
import { pipelinePaths, runPipeline } from "../scripts/run-pipeline.ts";

const canonPath = fileURLToPath(new URL("../data/canon.jsonl", import.meta.url));
const doctrinePath = fileURLToPath(new URL("../DOCTRINE.md", import.meta.url));

test("run-pipeline: submit -> approve -> publish (real gateway, stub content, no API)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "witness-pipeline-"));
  const siteDir = join(dir, "site");
  const pipelineDir = join(dir, "pipeline");
  const docId = "web/matthew/5";

  // Phase 1: submit to review. Nothing publishes.
  const submit = await runPipeline({
    phase: "submit",
    docId,
    langs: [],
    canonPath,
    siteDir,
    pipelineDir,
    doctrinePath,
    llm: new StubLlm(),
    quiet: true,
  });
  assert.equal(submit.status, "submitted");

  // Human approves the exact submitted bytes.
  const paths = pipelinePaths(pipelineDir, doctrinePath);
  recordReview(docId, "APPROVED", "tester", undefined, {
    reviewQueuePath: paths.reviewQueuePath,
    reviewReceiptsPath: paths.reviewReceiptsPath,
    doctrinePath,
  });

  // Phase 2: publish only approved content.
  const result = await runPipeline({
    phase: "publish",
    docId,
    langs: [],
    canonPath,
    siteDir,
    pipelineDir,
    doctrinePath,
    quiet: true,
  });

  assert.equal(result.status, "published");
  if (result.status !== "published") return;
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0]?.english.published, true);
  assert.ok(result.pagePaths.length >= 1);
  for (const p of result.pagePaths) assert.equal(existsSync(p), true);
  assert.equal(existsSync(result.coveragePath), true);
  assert.equal(result.report.rollups.publishedByLanguage.en, 1);
});
