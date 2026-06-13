/**
 * Step 4 tests — the Witness Ledger reports what is true, separately.
 *
 *   - mixed-state fixture -> correct per-unit + rollup numbers.
 *   - honest gap: a translation gap appears with its numeric score + reason,
 *     never dropped, never counted as published.
 *   - separation: published counts exclude quarantined units; the engagement
 *     section is present but empty/zeroed (not backfilled from publications).
 *   - deterministic output for a fixed fixture.
 *   - producer/consumer loop: real publishes (en + es) recorded and reported.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEnv } from "pfc-connector-gateway-proof";

import { CanonStore } from "../src/canon.ts";
import { processUnit } from "../src/verify.ts";
import type { ContentUnit } from "../src/types.ts";
import {
  authorizeSitePublish,
  authorizeTranslatedPublish,
  publishPage,
  publishTranslatedPage,
  SitePublishAdapter,
} from "../src/publish.ts";
import { buildCoverageReport, type CoverageReport } from "../src/ledger.ts";
import { renderCoverageReport, writeCoverageReport } from "../src/ledger-report.ts";

function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function unit(id: string, refs = false): ContentUnit {
  return {
    unit_id: id,
    source_refs: refs ? [{ doc_id: "web/matthew/5", hash: "abc123" }] : [],
    body: `body of ${id}`,
    format: "markdown",
  };
}

/** Mixed-state fixture: en+es, fr-gap-with-score, content-quarantined, pt-not-attempted. */
function mixedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "witness-ledger-"));
  const paths = {
    publishQueuePath: join(dir, "publish.jsonl"),
    publicationsPath: join(dir, "publications.jsonl"),
    contentQuarantinePath: join(dir, "quarantine.jsonl"),
    translationQuarantinePath: join(dir, "translation-quarantine.jsonl"),
  };

  writeJsonl(paths.publishQueuePath, [
    { unit: unit("u-en-es", true), verifiedAt: "2026-01-01T00:00:00Z" },
    { unit: unit("u-fr-gap", true), verifiedAt: "2026-01-01T00:00:00Z" },
    { unit: unit("u-pt-na", true), verifiedAt: "2026-01-01T00:00:00Z" },
  ]);

  writeJsonl(paths.publicationsPath, [
    { unit_id: "u-en-es", lang: "en", target: "site:u-en-es", receiptId: "exr_1", publishedAt: "2026-01-02T00:00:00Z" },
    { unit_id: "u-en-es", lang: "es", target: "site:u-en-es:es", receiptId: "exr_2", publishedAt: "2026-01-02T00:00:00Z" },
    { unit_id: "u-fr-gap", lang: "en", target: "site:u-fr-gap", receiptId: "exr_3", publishedAt: "2026-01-02T00:00:00Z" },
    { unit_id: "u-pt-na", lang: "en", target: "site:u-pt-na", receiptId: "exr_4", publishedAt: "2026-01-02T00:00:00Z" },
  ]);

  writeJsonl(paths.contentQuarantinePath, [
    {
      unit: unit("u-content-q", false),
      errors: [{ code: "EMPTY_SOURCE_REFS", detail: "uncited content" }],
      quarantinedAt: "2026-01-01T00:00:00Z",
    },
  ]);

  writeJsonl(paths.translationQuarantinePath, [
    {
      unit_id: "u-fr-gap",
      lang: "fr",
      score: 0.42,
      threshold: 0.7,
      reason: "BACK_TRANSLATION_BELOW_THRESHOLD",
      quarantinedAt: "2026-01-03T00:00:00Z",
    },
  ]);

  return { dir, paths };
}

function byId(report: CoverageReport): Record<string, CoverageReport["units"][number]> {
  return Object.fromEntries(report.units.map((u) => [u.unit_id, u]));
}

// ---------------------------------------------------------------------------

test("mixed fixture: per-unit + rollups are correct", () => {
  const { paths } = mixedFixture();
  const report = buildCoverageReport(paths);

  assert.deepEqual(report.rollups, {
    totalUnits: 4,
    contentQuarantinedUnits: 1,
    unitsPublishedInEnglish: 3,
    publishedByLanguage: { en: 3, es: 1, fr: 0, pt: 0 },
    gapsByLanguage: { en: 1, es: 3, fr: 4, pt: 4 },
    languagesWithPublications: ["en", "es"],
  });

  const u = byId(report);
  assert.deepEqual(u["u-en-es"]?.languages.en, { status: "PUBLISHED", receiptId: "exr_1" });
  assert.deepEqual(u["u-en-es"]?.languages.es, { status: "PUBLISHED", receiptId: "exr_2" });
  assert.equal(u["u-en-es"]?.languages.fr.status, "GAP");
  assert.equal(u["u-pt-na"]?.languages.pt.status, "GAP");
  assert.equal(u["u-content-q"]?.contentQuarantined, true);
  assert.deepEqual(u["u-content-q"]?.contentQuarantineCodes, ["EMPTY_SOURCE_REFS"]);
});

test("honest gap: translation gap carries numeric score + reason, not counted as published", () => {
  const { paths } = mixedFixture();
  const report = buildCoverageReport(paths);
  const fr = byId(report)["u-fr-gap"]?.languages.fr;

  assert.equal(fr?.status, "GAP");
  if (fr?.status !== "GAP") return;
  assert.equal(fr.gapType, "BELOW_THRESHOLD");
  assert.equal(fr.score, 0.42); // numeric score preserved
  assert.equal(fr.reason, "BACK_TRANSLATION_BELOW_THRESHOLD");

  // Never silently promoted to published.
  assert.equal(report.rollups.publishedByLanguage.fr, 0);
  assert.ok(!report.rollups.languagesWithPublications.includes("fr"));
});

test("separation: published counts exclude quarantined units; engagement empty, not backfilled", () => {
  const { paths } = mixedFixture();
  const report = buildCoverageReport(paths);

  // The content-quarantined unit contributes to NO published count.
  assert.equal(report.rollups.publishedByLanguage.en, 3); // not 4
  assert.equal(report.rollups.unitsPublishedInEnglish, 3);
  const cq = byId(report)["u-content-q"];
  for (const lang of report.targetLanguages) {
    assert.equal(cq?.languages[lang].status, "GAP");
  }

  // Engagement is a separate claim: present but empty, never derived from data.
  assert.equal(report.engagement.measured, false);
  assert.equal(report.engagement.byPeopleGroup.length, 0);
  assert.ok(report.engagement.note.length > 0);
});

test("deterministic for a fixed fixture", () => {
  const { paths } = mixedFixture();
  const a = buildCoverageReport(paths);
  const b = buildCoverageReport(paths);
  assert.deepEqual(a, b);
  // Rendered HTML is deterministic too (no timestamps).
  assert.equal(renderCoverageReport(a), renderCoverageReport(b));
});

test("dashboard renders to dist/site/_coverage.html with the empty engagement section", () => {
  const { dir, paths } = mixedFixture();
  const report = buildCoverageReport(paths);
  const outDir = join(dir, "site");

  const path = writeCoverageReport(report, outDir);
  assert.equal(path, join(outDir, "_coverage.html"));
  assert.equal(existsSync(path), true);

  const html = readFileSync(path, "utf8");
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes("Engagement (not yet measured)"));
  assert.ok(html.includes("score 0.420"), "fr gap score rendered");
  assert.ok(html.includes("Units published in English: 3"));
  assert.ok(!/<script|<link|<img/i.test(html), "no external assets");
});

test("producer/consumer: real en + es publishes are recorded and reported", async () => {
  const slug = "intg-1";
  const dir = mkdtempSync(join(tmpdir(), "witness-ledger-intg-"));
  const paths = {
    publishPath: join(dir, "publish.jsonl"),
    quarantinePath: join(dir, "quarantine.jsonl"),
    translationQuarantinePath: join(dir, "translation-quarantine.jsonl"),
    publicationsPath: join(dir, "publications.jsonl"),
  };
  const outDir = join(dir, "site");

  // Verified unit into the publish queue.
  const canon = new CanonStore();
  const doc = canon.put({
    doc_id: "web/matthew/5",
    version: "WEB",
    lang: "en",
    text: "3 Blessed are the poor in spirit, for theirs is the Kingdom of Heaven.",
  });
  const u: ContentUnit = {
    unit_id: slug,
    source_refs: [{ doc_id: doc.doc_id, hash: doc.hash }],
    body: "Blessed are the poor in spirit.",
    format: "markdown",
  };
  assert.equal(processUnit(u, canon, paths).ok, true);

  // English publish.
  const envEn = createEnv([new SitePublishAdapter(slug, outDir)]);
  const en = await publishPage(u, envEn, authorizeSitePublish(envEn, slug), paths);
  assert.equal(en.published, true);

  // Spanish publish.
  const envEs = createEnv([new SitePublishAdapter(`${slug}:es`, outDir)]);
  const es = await publishTranslatedPage(u, "es", envEs, authorizeTranslatedPublish(envEs, slug, ["es"]), paths);
  assert.equal(es.published, true);

  // The ledger reads the publication records the publishes just produced.
  const report = buildCoverageReport({
    publishQueuePath: paths.publishPath,
    publicationsPath: paths.publicationsPath,
    contentQuarantinePath: paths.quarantinePath,
    translationQuarantinePath: paths.translationQuarantinePath,
  });
  const cov = report.units.find((x) => x.unit_id === slug);
  assert.equal(cov?.languages.en.status, "PUBLISHED");
  assert.equal(cov?.languages.es.status, "PUBLISHED");
  assert.equal(cov?.languages.fr.status, "GAP");
  assert.deepEqual(report.rollups.languagesWithPublications, ["en", "es"]);
});
