/**
 * Step 3 tests — translation is still a gated publish, and bad translations
 * become honest gaps (quarantine) rather than bad coverage.
 *
 *   1. good translation + authorized chain -> dist/site/<slug>.<lang>.html
 *      exists; GatewayExecution with an ExecutionResultReceipt.
 *   2. mangled translation (corrupt round-trip) -> score below threshold ->
 *      NO file on disk + a translation-quarantine entry carrying the numeric
 *      score.
 *   3. unauthorized language (chain authorizes site:foo:es, attempt
 *      site:foo:fr) -> gateway refusal, no file.
 *   4. all three Tier 1 languages publish under a fully-authorizing chain.
 *
 * Blocked/quarantined cases assert the real filesystem, not just return values.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEnv } from "pfc-connector-gateway-proof";

import { CanonStore } from "../src/canon.ts";
import { processUnit } from "../src/verify.ts";
import type { ContentUnit } from "../src/types.ts";
import {
  authorizeTranslatedPublish,
  publishTranslatedPage,
  SitePublishAdapter,
  type TranslationQuarantineRecord,
} from "../src/publish.ts";
import { QUALITY_THRESHOLD, StubTranslator, TIER1_LANGS } from "../src/translate.ts";

const FIXTURE_TEXT =
  "3 Blessed are the poor in spirit, for theirs is the Kingdom of Heaven.";

function setupQueuedUnit(slug: string) {
  const dir = mkdtempSync(join(tmpdir(), "witness-tr-"));
  const paths = {
    publishPath: join(dir, "publish.jsonl"),
    quarantinePath: join(dir, "quarantine.jsonl"),
    translationQuarantinePath: join(dir, "translation-quarantine.jsonl"),
  };
  const outDir = join(dir, "site");
  const canon = new CanonStore();
  const doc = canon.put({ doc_id: "web/matthew/5", version: "WEB", lang: "en", text: FIXTURE_TEXT });
  const unit: ContentUnit = {
    unit_id: slug,
    source_refs: [{ doc_id: doc.doc_id, hash: doc.hash }],
    body: "Blessed are the poor in spirit, for theirs is the Kingdom of Heaven.",
    format: "markdown",
  };
  assert.equal(processUnit(unit, canon, paths).ok, true, "precondition: unit queued");
  return { paths, outDir, unit };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

// ---------------------------------------------------------------------------

test("good translation + authorized chain: translated page written; GatewayExecution + ExecutionResultReceipt", async () => {
  const slug = "matthew-5-beatitudes";
  const lang = "es";
  const { paths, outDir, unit } = setupQueuedUnit(slug);
  const env = createEnv([new SitePublishAdapter(`${slug}:${lang}`, outDir)]);
  const chain = authorizeTranslatedPublish(env, slug, [lang]);

  const filePath = join(outDir, `${slug}.${lang}.html`);
  assert.equal(existsSync(filePath), false, "precondition: no page yet");

  const outcome = await publishTranslatedPage(unit, lang, env, chain, paths);

  assert.equal(outcome.published, true);
  if (!outcome.published) return;
  assert.equal(existsSync(filePath), true, "adapter wrote the translated page");
  assert.equal(outcome.path, filePath);
  assert.equal(outcome.execution.boundaryReceipt.status, "PRE_EFFECT");
  assert.equal(outcome.execution.executionResultReceipt.artifactType, "ExecutionResultReceipt");

  const html = readFileSync(filePath, "utf8");
  assert.ok(html.includes('<html lang="es">'), "lang attribute set");
  assert.ok(html.includes("Sources"), "same citation block carried forward");
  assert.ok(/canon [0-9a-f]{12}/.test(html), "English canon hash carried forward");
});

// ---------------------------------------------------------------------------

test("mangled translation: score below threshold -> NO file + translation-quarantine entry with the score", async () => {
  const slug = "mangled-page";
  const lang = "fr";
  const { paths, outDir, unit } = setupQueuedUnit(slug);
  const env = createEnv([new SitePublishAdapter(`${slug}:${lang}`, outDir)]);
  const chain = authorizeTranslatedPublish(env, slug, [lang]);

  // Corrupt the back-translation so the round-trip fails the quality gate.
  const badTranslator = new StubTranslator({ corruptBackTranslation: true });

  const outcome = await publishTranslatedPage(unit, lang, env, chain, paths, badTranslator);

  assert.equal(outcome.published, false);
  if (outcome.published) return;
  assert.equal(outcome.reason, "BACK_TRANSLATION_BELOW_THRESHOLD");

  // No page on disk.
  const filePath = join(outDir, `${slug}.${lang}.html`);
  assert.equal(existsSync(filePath), false, "below-threshold translation must not write a file");

  // The gateway was never asked.
  assert.equal(env.gateway.metrics.length, 0, "gateway not called when the gate fails");

  // A translation-quarantine entry exists, carrying the numeric score.
  const q = readJsonl<TranslationQuarantineRecord>(paths.translationQuarantinePath);
  assert.equal(q.length, 1);
  assert.equal(q[0]?.unit_id, slug);
  assert.equal(q[0]?.lang, lang);
  assert.equal(q[0]?.reason, "BACK_TRANSLATION_BELOW_THRESHOLD");
  assert.equal(typeof q[0]?.score, "number");
  assert.ok((q[0]?.score ?? 1) < QUALITY_THRESHOLD, `score ${q[0]?.score} must be < ${QUALITY_THRESHOLD}`);
  assert.equal(q[0]?.threshold, QUALITY_THRESHOLD);
});

// ---------------------------------------------------------------------------

test("unauthorized language: chain authorizes site:foo:es, attempt site:foo:fr -> refused, no file", async () => {
  const slug = "foo";
  const { paths, outDir, unit } = setupQueuedUnit(slug);
  // Adapter for the ATTEMPTED language is present — only the boundary can stop it.
  const env = createEnv([new SitePublishAdapter(`${slug}:fr`, outDir)]);
  const chain = authorizeTranslatedPublish(env, slug, ["es"]); // authorizes :es only

  const outcome = await publishTranslatedPage(unit, "fr", env, chain, paths);

  assert.equal(outcome.published, false);
  if (outcome.published) return;
  assert.equal(outcome.reason, "GATEWAY_REFUSAL");
  if (outcome.reason !== "GATEWAY_REFUSAL") return;
  assert.ok(outcome.errorCodes.includes("TARGET_NOT_PERMITTED"), outcome.errorCodes.join(","));

  const filePath = join(outDir, `${slug}.fr.html`);
  assert.equal(existsSync(filePath), false, "unauthorized language must not write a file");
});

// ---------------------------------------------------------------------------

test("all three Tier 1 languages publish under a fully-authorizing chain", async () => {
  const slug = "matthew-5-9";
  const { paths, outDir, unit } = setupQueuedUnit(slug);
  const adapters = TIER1_LANGS.map((l) => new SitePublishAdapter(`${slug}:${l}`, outDir));
  const env = createEnv(adapters);
  const chain = authorizeTranslatedPublish(env, slug, [...TIER1_LANGS]);

  for (const lang of TIER1_LANGS) {
    const outcome = await publishTranslatedPage(unit, lang, env, chain, paths);
    assert.equal(outcome.published, true, `${lang} should publish`);
    if (!outcome.published) continue;
    const filePath = join(outDir, `${slug}.${lang}.html`);
    assert.equal(existsSync(filePath), true, `page for ${lang} exists`);
    assert.ok(readFileSync(filePath, "utf8").includes(`<html lang="${lang}">`));
  }
});
