/**
 * Witness Engine step-1 tests — falsifiable claims:
 *   1. a unit whose every ref resolves + hash-matches reaches the publish queue
 *   2. a fabricated citation (doc_id not in canon) quarantines
 *   3. tampered canon text (hash mismatch on recompute) quarantines
 *   4. a zero-ref unit quarantines (fail-closed)
 * Plus: the seeded WEB Matthew canon is internally consistent, and the
 * pfc-connector-gateway-proof dependency import resolves.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CanonStore, canonHash } from "../src/canon.ts";
import { StubLlm, generateUnit } from "../src/engine.ts";
import { processUnit, verifyUnit } from "../src/verify.ts";
import type { ContentUnit, QuarantineRecord } from "../src/types.ts";

const FIXTURE_TEXT =
  "3 Blessed are the poor in spirit, for theirs is the Kingdom of Heaven.";

function freshPaths() {
  const dir = mkdtempSync(join(tmpdir(), "witness-"));
  return {
    publishPath: join(dir, "publish.jsonl"),
    quarantinePath: join(dir, "quarantine.jsonl"),
  };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

test("valid unit passes and lands in the publish queue", async () => {
  const canon = new CanonStore();
  canon.put({ doc_id: "web/matthew/5", version: "WEB", lang: "en", text: FIXTURE_TEXT });

  const unit = await generateUnit(
    { instruction: "Summarize the beatitude.", docIds: ["web/matthew/5"] },
    new StubLlm(),
    canon,
  );

  const paths = freshPaths();
  const result = processUnit(unit, canon, paths);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(readJsonl(paths.publishPath).length, 1);
  assert.equal(readJsonl(paths.quarantinePath).length, 0);
});

test("fabricated citation quarantines with UNRESOLVED_REF", () => {
  const canon = new CanonStore();
  canon.put({ doc_id: "web/matthew/5", version: "WEB", lang: "en", text: FIXTURE_TEXT });

  const unit: ContentUnit = {
    unit_id: "fabricated-1",
    source_refs: [{ doc_id: "web/matthew/99", hash: canonHash("anything") }],
    body: "As Matthew 99 says…",
    format: "markdown",
  };

  const paths = freshPaths();
  const result = processUnit(unit, canon, paths);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "UNRESOLVED_REF");
  assert.equal(readJsonl(paths.publishPath).length, 0);
  const q = readJsonl<QuarantineRecord>(paths.quarantinePath);
  assert.equal(q.length, 1);
  assert.equal(q[0]?.unit.unit_id, "fabricated-1");
});

test("tampered canon text quarantines with HASH_MISMATCH", async () => {
  // Unit generated against the original canon…
  const original = new CanonStore();
  original.put({ doc_id: "web/matthew/5", version: "WEB", lang: "en", text: FIXTURE_TEXT });
  const unit = await generateUnit(
    { instruction: "Summarize.", docIds: ["web/matthew/5"] },
    new StubLlm(),
    original,
  );

  // …verified against a canon whose text was altered after the fact.
  const tampered = new CanonStore();
  tampered.put({
    doc_id: "web/matthew/5",
    version: "WEB",
    lang: "en",
    text: FIXTURE_TEXT.replace("poor in spirit", "rich in spirit"),
  });

  const paths = freshPaths();
  const result = processUnit(unit, tampered, paths);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "HASH_MISMATCH");
  assert.equal(readJsonl(paths.publishPath).length, 0);
  assert.equal(readJsonl(paths.quarantinePath).length, 1);
});

test("zero-ref unit quarantines (fail-closed)", () => {
  const canon = new CanonStore();
  const unit: ContentUnit = {
    unit_id: "uncited-1",
    source_refs: [],
    body: "Trust me.",
    format: "plain",
  };

  const paths = freshPaths();
  const result = processUnit(unit, canon, paths);

  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.code, "EMPTY_SOURCE_REFS");
  assert.equal(readJsonl(paths.publishPath).length, 0);
  assert.equal(readJsonl(paths.quarantinePath).length, 1);
});

test("seeded WEB Matthew canon loads and is internally consistent", () => {
  const path = new URL("../data/canon.jsonl", import.meta.url).pathname;
  const canon = new CanonStore(path);
  assert.equal(canon.size, 28, "expected all 28 chapters of Matthew");
  for (const doc of canon) {
    assert.equal(canonHash(doc.text), doc.hash, `stored hash stale for ${doc.doc_id}`);
    assert.equal(doc.version, "WEB");
    assert.equal(doc.lang, "en");
  }
  // a unit citing the real seeded canon verifies
  const ch5 = canon.get("web/matthew/5")!;
  const unit: ContentUnit = {
    unit_id: "seeded-1",
    source_refs: [{ doc_id: ch5.doc_id, hash: ch5.hash }],
    body: "Grounded in Matthew 5.",
    format: "markdown",
  };
  assert.equal(verifyUnit(unit, canon).ok, true);
});

test("pfc-connector-gateway-proof dependency imports cleanly", async () => {
  const m = await import("pfc-connector-gateway-proof");
  assert.equal(typeof m.verifyChain, "function");
  assert.ok(m.CHAIN_VERIFICATION_ERROR_CODES.length > 0);
});
