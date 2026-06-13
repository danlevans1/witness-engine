/**
 * Step 2 tests — the point of the step is falsifiable gating:
 *
 *   1. authorized chain  -> page written by the adapter; GatewayExecution with
 *      an ExecutionResultReceipt; BoundaryReceipt PRE_EFFECT.
 *   2. invalid authorization (revoked token) -> NOTHING written: the file does
 *      NOT exist on disk, and the outcome is a GatewayRefusal carrying
 *      TOKEN_REVOKED.
 *   3. out-of-scope target (chain authorizes site:foo, publish attempts
 *      site:bar) -> refused with TARGET_NOT_PERMITTED, no file on disk.
 *   4. quarantined unit -> rejected (QuarantinedUnitRejected) BEFORE the
 *      gateway is called (gateway records zero executions), no file.
 *
 * Every "blocked" assertion checks the actual filesystem, not just a return
 * value. The page write lives solely inside SitePublishAdapter, which only the
 * gateway invokes — so file absence is real proof the boundary held.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEnv, nowIso } from "pfc-connector-gateway-proof";

import { CanonStore } from "../src/canon.ts";
import { processUnit } from "../src/verify.ts";
import type { ContentUnit } from "../src/types.ts";
import {
  authorizeSitePublish,
  publishPage,
  QuarantinedUnitRejected,
  SitePublishAdapter,
} from "../src/publish.ts";

const FIXTURE_TEXT =
  "3 Blessed are the poor in spirit, for theirs is the Kingdom of Heaven.";

/** A verified unit routed through Step 1's gate into a fresh publish queue. */
function setupQueuedUnit(slug: string) {
  const dir = mkdtempSync(join(tmpdir(), "witness-pub-"));
  const paths = {
    publishPath: join(dir, "publish.jsonl"),
    quarantinePath: join(dir, "quarantine.jsonl"),
  };
  const outDir = join(dir, "site");

  const canon = new CanonStore();
  const doc = canon.put({ doc_id: "web/matthew/5", version: "WEB", lang: "en", text: FIXTURE_TEXT });
  const unit: ContentUnit = {
    unit_id: slug,
    source_refs: [{ doc_id: doc.doc_id, hash: doc.hash }],
    body: "Blessed are the poor in spirit.\n\nA grounded reflection on Matthew 5.",
    format: "markdown",
  };
  const res = processUnit(unit, canon, paths);
  assert.equal(res.ok, true, "precondition: unit must reach the publish queue");

  return { paths, outDir, unit, filePath: join(outDir, `${slug}.html`) };
}

// ---------------------------------------------------------------------------

test("authorized chain publishes: adapter writes the page; GatewayExecution + ExecutionResultReceipt", async () => {
  const slug = "matthew-5-beatitudes";
  const { paths, outDir, unit, filePath } = setupQueuedUnit(slug);
  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, slug);

  assert.equal(existsSync(filePath), false, "precondition: no page yet");

  const outcome = await publishPage(unit, env, chain, paths);

  assert.equal(outcome.published, true);
  if (!outcome.published) return;

  assert.equal(existsSync(filePath), true, "the adapter wrote the page");
  assert.equal(outcome.path, filePath);
  assert.equal(outcome.execution.ok, true);
  assert.equal(outcome.execution.boundaryReceipt.status, "PRE_EFFECT");
  assert.ok(outcome.execution.executionResultReceipt, "ExecutionResultReceipt emitted");
  assert.equal(
    outcome.execution.executionResultReceipt.artifactType,
    "ExecutionResultReceipt",
  );

  // Content sanity: citation (short canon hash) + on-ramp footer, sub-100KB,
  // no external assets.
  const html = readFileSync(filePath, "utf8");
  assert.ok(html.includes("Sources"), "citations present");
  assert.ok(/canon [0-9a-f]{12}/.test(html), "short canon hash present");
  assert.ok(html.toLowerCase().includes("next step"), "on-ramp footer present");
  assert.ok(!/<script|<link|<img/i.test(html), "no external assets");
  assert.ok(Buffer.byteLength(html, "utf8") < 100_000, "sub-100KB");
});

// ---------------------------------------------------------------------------

test("invalid authorization (revoked token): nothing written on disk; GatewayRefusal TOKEN_REVOKED", async () => {
  const slug = "revoked-page";
  const { paths, outDir, unit, filePath } = setupQueuedUnit(slug);
  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, slug);

  // Withdraw authorization before publishing.
  env.revocationLog.revoke({
    artifactId: chain.tokenId,
    revokedAt: nowIso(),
    reason: "operator withdrew authorization",
    revokedBy: "human:dan@example.com",
  });

  const outcome = await publishPage(unit, env, chain, paths);

  assert.equal(outcome.published, false);
  if (outcome.published) return;
  assert.ok(outcome.errorCodes.includes("TOKEN_REVOKED"), outcome.errorCodes.join(","));
  assert.equal(outcome.refusal.boundaryReceipt.status, "BLOCKED");

  // The real proof: no file on disk.
  assert.equal(existsSync(filePath), false, "blocked publish must not write a file");
});

// ---------------------------------------------------------------------------

test("out-of-scope target: chain authorizes site:foo, publish attempts site:bar -> refused, no file", async () => {
  const slug = "bar"; // unit publishes to site:bar
  const { paths, outDir, unit, filePath } = setupQueuedUnit(slug);
  // Adapter for site:bar IS present and able — so only the boundary can stop it.
  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, "foo"); // authorizes site:foo ONLY

  const outcome = await publishPage(unit, env, chain, paths);

  assert.equal(outcome.published, false);
  if (outcome.published) return;
  assert.ok(
    outcome.errorCodes.includes("TARGET_NOT_PERMITTED"),
    outcome.errorCodes.join(","),
  );
  assert.equal(existsSync(filePath), false, "out-of-scope publish must not write a file");
});

// ---------------------------------------------------------------------------

test("quarantined unit: rejected before the gateway is called; no file", async () => {
  const slug = "quarantined-page";
  const dir = mkdtempSync(join(tmpdir(), "witness-pub-"));
  const paths = {
    publishPath: join(dir, "publish.jsonl"),
    quarantinePath: join(dir, "quarantine.jsonl"),
  };
  const outDir = join(dir, "site");
  const filePath = join(outDir, `${slug}.html`);

  // Force quarantine via Step 1's gate (zero refs -> EMPTY_SOURCE_REFS).
  const canon = new CanonStore();
  const unit: ContentUnit = { unit_id: slug, source_refs: [], body: "Trust me.", format: "plain" };
  assert.equal(processUnit(unit, canon, paths).ok, false, "precondition: unit quarantined");

  const env = createEnv([new SitePublishAdapter(slug, outDir)]);
  const chain = authorizeSitePublish(env, slug);

  await assert.rejects(
    () => publishPage(unit, env, chain, paths),
    (err: unknown) => err instanceof QuarantinedUnitRejected && err.unit_id === slug,
  );

  // The gateway was never asked: zero executions recorded.
  assert.equal(env.gateway.metrics.length, 0, "gateway must not have been called");
  assert.equal(existsSync(filePath), false, "quarantined unit must not produce a file");
});
