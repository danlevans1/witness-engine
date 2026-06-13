/**
 * Step 4 — the Witness Ledger (reporting layer).
 *
 * Pure function: reads the records the pipeline already produces (publish
 * queue, publication receipts, content quarantine, translation quarantine) and
 * joins them into an honest CoverageReport. No I/O beyond reading the named
 * JSONL paths; no new gated effects.
 *
 * Honesty contract enforced here:
 *   - "Published in language X" comes ONLY from publication records (proof a
 *     page actually published), never from mere queue membership or rendered
 *     files.
 *   - A gap always carries its reason; a translation gap carries its numeric
 *     score. Gaps are never silently dropped and never counted as published.
 *   - "Published in language X" and "engagement evidence from people-group Y"
 *     are different claims. v0.1 has no engagement data, so the engagement
 *     section is explicitly empty and is NEVER derived from publication data.
 */
import { existsSync, readFileSync } from "node:fs";
import type {
  PublicationRecord,
  PublishRecord,
  QuarantineRecord,
} from "./types.ts";
import type { TranslationQuarantineRecord } from "./publish.ts";

/** Tier 1 target set: English plus the three Tier 1 translation languages. */
export const TARGET_LANGUAGES = ["en", "es", "fr", "pt"] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

export type GapType = "NOT_ATTEMPTED" | "BELOW_THRESHOLD";

export type LanguageCoverage =
  | { status: "PUBLISHED"; receiptId: string }
  | { status: "GAP"; gapType: GapType; reason: string; score?: number };

export interface UnitCoverage {
  unit_id: string;
  contentQuarantined: boolean;
  contentQuarantineCodes: string[]; // [] unless content-quarantined
  languages: Record<TargetLanguage, LanguageCoverage>;
}

export interface CoverageRollups {
  totalUnits: number;
  contentQuarantinedUnits: number;
  unitsPublishedInEnglish: number;
  publishedByLanguage: Record<TargetLanguage, number>;
  gapsByLanguage: Record<TargetLanguage, number>;
  languagesWithPublications: TargetLanguage[];
}

/**
 * Engagement is a DIFFERENT claim from publication and is not measured at v0.1.
 * This section is intentionally empty and must never be backfilled from
 * publication data.
 */
export interface EngagementSection {
  measured: false;
  note: string;
  byPeopleGroup: never[];
}

export interface CoverageReport {
  targetLanguages: TargetLanguage[];
  units: UnitCoverage[];
  rollups: CoverageRollups;
  engagement: EngagementSection;
}

export interface CoveragePaths {
  publishQueuePath: string;
  publicationsPath: string;
  contentQuarantinePath: string;
  translationQuarantinePath: string;
}

const ENGAGEMENT_NOTE =
  "Engagement evidence is not collected at v0.1. “Published in language X” " +
  "is a publication claim only; it is NOT evidence that any people-group engaged " +
  "with the content. This section is intentionally empty and is never derived " +
  "from publication data.";

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

function emptyLangCount(): Record<TargetLanguage, number> {
  return { en: 0, es: 0, fr: 0, pt: 0 };
}

/** Read and join the pipeline records into an honest coverage report. */
export function buildCoverageReport(paths: CoveragePaths): CoverageReport {
  const queue = readJsonl<PublishRecord>(paths.publishQueuePath);
  const pubs = readJsonl<PublicationRecord>(paths.publicationsPath);
  const contentQ = readJsonl<QuarantineRecord>(paths.contentQuarantinePath);
  const translationQ = readJsonl<TranslationQuarantineRecord>(paths.translationQuarantinePath);

  // publications: unit_id -> lang -> record (source of truth for "published").
  const pubByUnit = new Map<string, Map<string, PublicationRecord>>();
  for (const p of pubs) {
    let m = pubByUnit.get(p.unit_id);
    if (!m) {
      m = new Map();
      pubByUnit.set(p.unit_id, m);
    }
    m.set(p.lang, p);
  }

  // translation quarantine: unit_id -> lang -> worst (lowest) score record.
  const tqByUnit = new Map<string, Map<string, TranslationQuarantineRecord>>();
  for (const t of translationQ) {
    let m = tqByUnit.get(t.unit_id);
    if (!m) {
      m = new Map();
      tqByUnit.set(t.unit_id, m);
    }
    const existing = m.get(t.lang);
    if (!existing || t.score < existing.score) m.set(t.lang, t);
  }

  // content quarantine: unit_id -> error codes.
  const contentQByUnit = new Map<string, string[]>();
  for (const q of contentQ) {
    const prior = contentQByUnit.get(q.unit.unit_id) ?? [];
    contentQByUnit.set(q.unit.unit_id, [...prior, ...q.errors.map((e) => e.code)]);
  }

  // Universe of unit_ids across every source, deterministically ordered.
  const ids = new Set<string>();
  for (const r of queue) ids.add(r.unit.unit_id);
  for (const p of pubs) ids.add(p.unit_id);
  for (const id of contentQByUnit.keys()) ids.add(id);
  for (const t of translationQ) ids.add(t.unit_id);
  const sortedIds = [...ids].sort();

  const publishedByLanguage = emptyLangCount();
  const gapsByLanguage = emptyLangCount();
  let unitsPublishedInEnglish = 0;
  let contentQuarantinedUnits = 0;

  const units: UnitCoverage[] = sortedIds.map((id) => {
    const codes = contentQByUnit.get(id) ?? [];
    const contentQuarantined = codes.length > 0;
    if (contentQuarantined) contentQuarantinedUnits++;

    const languages = emptyLangCoverage();
    for (const lang of TARGET_LANGUAGES) {
      const pub = pubByUnit.get(id)?.get(lang);
      if (pub) {
        languages[lang] = { status: "PUBLISHED", receiptId: pub.receiptId };
        publishedByLanguage[lang] += 1;
        if (lang === "en") unitsPublishedInEnglish += 1;
        continue;
      }
      const tq = tqByUnit.get(id)?.get(lang);
      if (tq) {
        languages[lang] = {
          status: "GAP",
          gapType: "BELOW_THRESHOLD",
          reason: tq.reason,
          score: tq.score,
        };
      } else if (contentQuarantined) {
        languages[lang] = {
          status: "GAP",
          gapType: "NOT_ATTEMPTED",
          reason: `content quarantined (${codes.join(", ")})`,
        };
      } else {
        languages[lang] = {
          status: "GAP",
          gapType: "NOT_ATTEMPTED",
          reason: "no publication record",
        };
      }
      gapsByLanguage[lang] += 1;
    }

    return { unit_id: id, contentQuarantined, contentQuarantineCodes: codes, languages };
  });

  const languagesWithPublications = TARGET_LANGUAGES.filter((l) => publishedByLanguage[l] > 0);

  return {
    targetLanguages: [...TARGET_LANGUAGES],
    units,
    rollups: {
      totalUnits: units.length,
      contentQuarantinedUnits,
      unitsPublishedInEnglish,
      publishedByLanguage,
      gapsByLanguage,
      languagesWithPublications,
    },
    engagement: {
      measured: false,
      note: ENGAGEMENT_NOTE,
      byPeopleGroup: [],
    },
  };
}

function emptyLangCoverage(): Record<TargetLanguage, LanguageCoverage> {
  const base: LanguageCoverage = { status: "GAP", gapType: "NOT_ATTEMPTED", reason: "no publication record" };
  return { en: base, es: base, fr: base, pt: base };
}
