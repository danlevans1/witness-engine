/**
 * Deploy integrity-gate tests — fail-closed: no valid approval, no deploy.
 *
 *   1. all pages have matching approvals -> all deployable, none blocked.
 *   2. a hand-dropped page (no source unit) -> blocked; CLI gate refuses (not clear).
 *   3. a page whose content changed after approval (hash != receipt) -> blocked.
 *   4. _coverage.html is an exempt operator artifact (deployable, not blocked).
 *
 * Tests exercise verifyDeployable + the block/allow decision only. No git push.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { recordReview, submitForReview } from "../src/review.ts";
import type { ContentUnit } from "../src/types.ts";
import { isDeployClear, verifyDeployable } from "../src/deploy.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "witness-deploy-"));
  const distDir = join(dir, "site");
  mkdirSync(distDir, { recursive: true });
  const paths = {
    reviewQueuePath: join(dir, "review-queue.jsonl"),
    reviewReceiptsPath: join(dir, "review-receipts.jsonl"),
  };
  return { distDir, paths };
}

function unit(id: string, body: string): ContentUnit {
  return {
    unit_id: id,
    source_refs: [{ doc_id: "web/matthew/5", hash: "x" }],
    body,
    format: "markdown",
  };
}

function writePage(distDir: string, file: string): void {
  writeFileSync(join(distDir, file), `<!doctype html><html><body>${file}</body></html>`, "utf8");
}

// ---------------------------------------------------------------------------

test("all pages with matching approvals are deployable, none blocked", () => {
  const { distDir, paths } = setup();
  const u = unit("web/matthew/5", "Approved exposition.");
  submitForReview(u, paths);
  recordReview(u.unit_id, "APPROVED", "reviewer", undefined, paths);

  // English page + a translation (traces to the same source unit) + coverage.
  writePage(distDir, "web-matthew-5.html");
  writePage(distDir, "web-matthew-5.es.html");
  writePage(distDir, "_coverage.html");

  const v = verifyDeployable(distDir, paths);
  assert.deepEqual(v.blocked, []);
  assert.ok(v.deployable.includes("web-matthew-5.html"));
  assert.ok(v.deployable.includes("web-matthew-5.es.html"));
  assert.equal(isDeployClear(v), true);
});

test("hand-dropped page with no source unit is blocked; deploy gate refuses", () => {
  const { distDir, paths } = setup();
  const u = unit("web/matthew/5", "Approved exposition.");
  submitForReview(u, paths);
  recordReview(u.unit_id, "APPROVED", "reviewer", undefined, paths);
  writePage(distDir, "web-matthew-5.html");

  // A file nobody reviewed, dropped straight into dist/site.
  writePage(distDir, "hand-dropped.html");

  const v = verifyDeployable(distDir, paths);
  assert.ok(
    v.blocked.some((b) => b.file === "hand-dropped.html" && b.reason === "NO_SOURCE_UNIT"),
    JSON.stringify(v.blocked),
  );
  assert.equal(isDeployClear(v), false); // CLI exits nonzero, no push
});

test("content changed after approval (hash != receipt) is blocked", () => {
  const { distDir, paths } = setup();
  // Approve the original bytes...
  submitForReview(unit("web/matthew/5", "Original approved bytes."), paths);
  recordReview("web/matthew/5", "APPROVED", "reviewer", undefined, paths);
  // ...then the content backing the page changes (tamper after approval).
  submitForReview(unit("web/matthew/5", "Edited AFTER approval — different bytes."), paths);

  writePage(distDir, "web-matthew-5.html");

  const v = verifyDeployable(distDir, paths);
  assert.ok(
    v.blocked.some((b) => b.file === "web-matthew-5.html" && b.reason === "NO_VALID_APPROVAL"),
    JSON.stringify(v.blocked),
  );
  assert.equal(isDeployClear(v), false);
});

test("_coverage.html is an exempt operator artifact, not blocked for lacking a receipt", () => {
  const { distDir, paths } = setup();
  // No receipts at all; only the coverage dashboard present.
  writePage(distDir, "_coverage.html");

  const v = verifyDeployable(distDir, paths);
  assert.deepEqual(v.blocked, []);
  assert.ok(v.exempt.includes("_coverage.html"));
  assert.ok(v.deployable.includes("_coverage.html"));
  assert.equal(isDeployClear(v), true);
});
