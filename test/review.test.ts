/**
 * Human-review gate tests — the point of this step: unreviewed content cannot
 * reach the publish gateway, and approval binds to exact bytes.
 *
 *   1. unreviewed     -> publishPage blocks REVIEW_REQUIRED, no file, gateway never called.
 *   2. approved       -> publishes (gateway reached, page written).
 *   3. rejected       -> blocked REVIEW_REJECTED, no file.
 *   4. stale approval -> approve, edit content, publish -> REVIEW_STALE, no file (hash-binding).
 *   5. translated     -> inherits the source unit's approval requirement (blocked unreviewed).
 *
 * Every blocked case asserts file ABSENCE on disk and that the gateway was not
 * called. The review gate throws (fail-closed) like the quarantine gate.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

import { createEnv } from "pfc-connector-gateway-proof";

import { CanonStore } from "../src/canon.ts";
import { processUnit } from "../src/verify.ts";
import type { ContentUnit } from "../src/types.ts";
import { ReviewBlocked, recordReview, submitForReview } from "../src/review.ts";
import { StubTranslator } from "../src/translate.ts";
import {
  authorizeSitePublish,
  authorizeTranslatedPublish,
  publishPage,
  publishTranslatedPage,
  SitePublishAdapter,
} from "../src/publish.ts";

const FIXTURE_TEXT = "3 Blessed are the poor in spirit, for theirs is the Kingdom of Heaven.";
const doctrinePath = fileURLToPath(new URL("../DOCTRINE.md", import.meta.url));

/** A grounded, queued, submitted-for-review unit with review paths configured. */
function setup(slug: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "witness-review-"));
  const paths = {
    publishPath: join(dir, "publish.jsonl"),
    quarantinePath: join(dir, "quarantine.jsonl"),
    translationQuarantinePath: join(dir, "translation-quarantine.jsonl"),
    publicationsPath: join(dir, "publications.jsonl"),
    reviewQueuePath: join(dir, "review-queue.jsonl"),
    reviewReceiptsPath: join(dir, "review-receipts.jsonl"),
    doctrinePath,
  };
  const outDir = join(dir, "site");
  const canon = new CanonStore();
  const doc = canon.put({ doc_id: "web/matthew/5", version: "WEB", lang: "en", text: FIXTURE_TEXT });
  const unit: ContentUnit = {
    unit_id: slug,
    source_refs: [{ doc_id: doc.doc_id, hash: doc.hash }],
    body,
    format: "markdown",
  };
  // Grounded + in the publish queue.
  assert.equal(processUnit(unit, canon, paths).ok, true);
  // Submitted for human review (pending).
  submitForReview(unit, paths);
  return { paths, outDir, unit, filePath: join(outDir, `${slug}.html`) };
}

// ---------------------------------------------------------------------------

test("unreviewed unit: publishPage blocks REVIEW_REQUIRED, no file, gateway never called", async () => {
  const slug = "rev-unreviewed";
  const { paths, outDir, unit, filePath } = setup(slug, "Exposition pending review.");
  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, slug);

  await assert.rejects(
    () => publishPage(unit, env, chain, paths),
    (e: unknown) => e instanceof ReviewBlocked && e.code === "REVIEW_REQUIRED",
  );
  assert.equal(env.gateway.metrics.length, 0, "gateway must not be called");
  assert.equal(existsSync(filePath), false, "no file for unreviewed content");
});

test("approved unit (matching hash): publishes normally", async () => {
  const slug = "rev-approved";
  const { paths, outDir, unit, filePath } = setup(slug, "Approved exposition.");
  recordReview(unit.unit_id, "APPROVED", "reviewer@example", undefined, paths);

  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, slug);
  const outcome = await publishPage(unit, env, chain, paths);

  assert.equal(outcome.published, true);
  if (!outcome.published) return;
  assert.equal(existsSync(filePath), true, "approved content publishes");
  assert.equal(outcome.execution.boundaryReceipt.status, "PRE_EFFECT");
});

test("rejected unit: blocked REVIEW_REJECTED, no file, gateway never called", async () => {
  const slug = "rev-rejected";
  const { paths, outDir, unit, filePath } = setup(slug, "Rejected exposition.");
  recordReview(unit.unit_id, "REJECTED", "reviewer@example", "off-doctrine", paths);

  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, slug);

  await assert.rejects(
    () => publishPage(unit, env, chain, paths),
    (e: unknown) => e instanceof ReviewBlocked && e.code === "REVIEW_REJECTED",
  );
  assert.equal(env.gateway.metrics.length, 0);
  assert.equal(existsSync(filePath), false);
});

test("stale approval: edit content after approval -> REVIEW_STALE, no file (hash-binding)", async () => {
  const slug = "rev-stale";
  const { paths, outDir, unit, filePath } = setup(slug, "Original approved bytes.");
  recordReview(unit.unit_id, "APPROVED", "reviewer@example", undefined, paths);

  // Tamper after approval: the content hash now diverges from the receipt's.
  unit.body = "Edited AFTER approval — different bytes.";

  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, slug);

  await assert.rejects(
    () => publishPage(unit, env, chain, paths),
    (e: unknown) => e instanceof ReviewBlocked && e.code === "REVIEW_STALE",
  );
  assert.equal(env.gateway.metrics.length, 0, "stale approval must not reach the gateway");
  assert.equal(existsSync(filePath), false, "edited-after-approval content must not publish");
});

test("translated publish inherits the source unit's approval requirement", async () => {
  const slug = "rev-translated";
  const { paths, outDir, unit } = setup(slug, "Source exposition for translation.");
  const env = createEnv([new SitePublishAdapter(`${slug}:es`, outDir)]);
  const chain = authorizeTranslatedPublish(env, slug, ["es"]);
  const filePath = join(outDir, `${slug}.es.html`);

  // Source unit not reviewed -> translation must not publish.
  await assert.rejects(
    () => publishTranslatedPage(unit, "es", env, chain, paths, new StubTranslator()),
    (e: unknown) => e instanceof ReviewBlocked && e.code === "REVIEW_REQUIRED",
  );
  assert.equal(env.gateway.metrics.length, 0);
  assert.equal(existsSync(filePath), false);

  // After approving the source unit, the translation publishes.
  recordReview(unit.unit_id, "APPROVED", "reviewer@example", undefined, paths);
  const outcome = await publishTranslatedPage(unit, "es", env, chain, paths, new StubTranslator());
  assert.equal(outcome.published, true);
  assert.equal(existsSync(filePath), true);
});
