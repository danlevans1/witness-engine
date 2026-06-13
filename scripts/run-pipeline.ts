/**
 * Operator runner — two phases around the unavoidable human-review gate.
 *
 *   node scripts/run-pipeline.ts <canon-doc-id> [--langs es,fr,pt]   # SUBMIT
 *   node scripts/run-pipeline.ts [<canon-doc-id>] --publish [--langs] # PUBLISH
 *
 * Default (SUBMIT): generate -> ground-verify -> submit to the review queue and
 * STOP. Nothing publishes. The operator reviews via `scripts/review.ts`, then
 * re-runs with --publish.
 *
 * PUBLISH: publishes ONLY units that carry a valid matching human approval,
 * skipping/reporting any still-pending, rejected, or stale ones. This makes the
 * human gate unavoidable in the normal flow.
 *
 * Real API calls live only here and in the translator/engine, never in tests.
 * ANTHROPIC_API_KEY is required for the whole run (content generation +
 * translation use the Claude API).
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AGENT_A,
  AGENT_B,
  createEnv,
  FRESHNESS_DEFAULTS,
  issueDelegationToken,
  issueHumanAuthReceipt,
} from "pfc-connector-gateway-proof";
import type { DelegationToken, Env, ToolScope } from "pfc-connector-gateway-proof";

import { CanonStore } from "../src/canon.ts";
import { ClaudeLlm, generateUnit, type LlmClient } from "../src/engine.ts";
import { processUnit, verifyUnit } from "../src/verify.ts";
import {
  publishLangAction,
  publishPage,
  publishTranslatedPage,
  siteLangTarget,
  siteTarget,
  publishAction,
  slugForUnit,
  SitePublishAdapter,
  type PublishOutcome,
  type PublishQueuePaths,
  type TranslatedPublishOutcome,
} from "../src/publish.ts";
import { reviewStatus, submitForReview, type ReviewQueueEntry } from "../src/review.ts";
import {
  ANTHROPIC_API_KEY_ENV,
  ClaudeTranslator,
  isTier1Lang,
  TIER1_LANGS,
} from "../src/translate.ts";
import { buildCoverageReport, type CoverageReport } from "../src/ledger.ts";
import { writeCoverageReport } from "../src/ledger-report.ts";
import type { ContentUnit, QuarantineRecord } from "../src/types.ts";

export interface PipelinePaths extends PublishQueuePaths {
  publishPath: string;
  quarantinePath: string;
  translationQuarantinePath: string;
  publicationsPath: string;
  reviewQueuePath: string;
  reviewReceiptsPath: string;
  doctrinePath?: string;
}

/** All pipeline record locations, derived from one pipeline directory. */
export function pipelinePaths(pipelineDir: string, doctrinePath?: string): PipelinePaths {
  return {
    publishPath: `${pipelineDir}/publish.jsonl`,
    quarantinePath: `${pipelineDir}/quarantine.jsonl`,
    translationQuarantinePath: `${pipelineDir}/translation-quarantine.jsonl`,
    publicationsPath: `${pipelineDir}/publications.jsonl`,
    reviewQueuePath: `${pipelineDir}/review-queue.jsonl`,
    reviewReceiptsPath: `${pipelineDir}/review-receipts.jsonl`,
    ...(doctrinePath !== undefined ? { doctrinePath } : {}),
  };
}

export interface RunPipelineOptions {
  phase: "submit" | "publish";
  docId?: string; // required for submit; optional filter for publish
  langs: string[];
  canonPath: string;
  siteDir: string;
  pipelineDir: string;
  doctrinePath?: string;
  llm?: LlmClient; // required for submit (content generation)
  quiet?: boolean;
}

export type PipelineRunResult =
  | { status: "doc-not-found"; docId: string }
  | { status: "quarantined"; docId: string; unitId: string; errorCodes: string[] }
  | { status: "submitted"; docId: string; unitId: string; contentHash: string }
  | {
      status: "published";
      units: Array<{
        unitId: string;
        slug: string;
        english: PublishOutcome;
        translations: Array<{ lang: string; outcome: TranslatedPublishOutcome }>;
      }>;
      skipped: Array<{ unitId: string; reason: string }>;
      pagePaths: string[];
      coveragePath: string;
      report: CoverageReport;
    };

function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

/**
 * Issue ONE authorizing delegation chain covering the English target and each
 * requested language target — same harness builders the tests use, combined
 * scope so a single human authorization covers the run.
 */
function authorizeRun(env: Env, slug: string, langs: string[]): DelegationToken {
  const scope: ToolScope = {
    permittedTargets: [siteTarget(slug), ...langs.map((l) => siteLangTarget(slug, l))],
    permittedActions: [publishAction(slug), ...langs.map((l) => publishLangAction(slug, l))],
  };
  const receipt = issueHumanAuthReceipt({
    governanceKey: env.keys.governance,
    grantedBy: "human:operator",
    authorizedAgent: AGENT_A,
    scope,
    usagePolicy: "MULTI_USE",
    maxUses: 1000,
    ttlMs: 3_600_000,
    cfg: env.cfg,
  });
  return issueDelegationToken({
    issuerAgentId: AGENT_A,
    issuerKey: env.keys.agentA,
    delegateeAgentId: AGENT_B,
    delegateeKeyId: env.keys.agentB.keyId,
    parent: receipt,
    scope,
    freshnessBound: FRESHNESS_DEFAULTS.MEDIUM,
    ttlMs: 600_000,
    cfg: env.cfg,
  });
}

export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineRunResult> {
  const say = opts.quiet ? () => {} : (m: string) => console.log(m);
  const langs = opts.langs.filter(isTier1Lang);
  const paths = pipelinePaths(opts.pipelineDir, opts.doctrinePath);

  // ---- SUBMIT phase: generate -> ground-verify -> review queue, then STOP ----
  if (opts.phase === "submit") {
    rmSync(opts.pipelineDir, { recursive: true, force: true }); // fresh review cycle
    if (opts.docId === undefined) throw new Error("runPipeline(submit): docId is required");
    if (opts.llm === undefined) throw new Error("runPipeline(submit): llm is required");

    const canon = new CanonStore(opts.canonPath);
    const doc = canon.get(opts.docId);
    if (!doc) {
      say(`error: canon doc ${opts.docId} not found (seed with: npm run seed)`);
      return { status: "doc-not-found", docId: opts.docId };
    }
    say(`canon: ${doc.doc_id} (${doc.version}, ${doc.lang}), ${doc.text.length} chars`);
    say(
      opts.llm instanceof ClaudeLlm
        ? "content: generated via Claude API (claude-sonnet-4-6)"
        : "NOTICE: content is STUBBED (not real generated content) — plumbing only",
    );

    const unit: ContentUnit = await generateUnit(
      { instruction: `Write a faithful exposition of ${doc.doc_id}.`, docIds: [doc.doc_id] },
      opts.llm,
      canon,
    );
    unit.unit_id = opts.docId; // readable, deterministic id for page names

    // Ground-verify. Quarantined -> quarantine JSONL. Grounded -> REVIEW QUEUE
    // (pending), NOT the publish path: nothing is publishable until approved.
    const v = verifyUnit(unit, canon);
    if (!v.ok) {
      const rec: QuarantineRecord = {
        unit,
        errors: v.errors,
        quarantinedAt: new Date().toISOString(),
      };
      appendJsonl(paths.quarantinePath, rec);
      const codes = v.errors.map((e) => e.code);
      say(`QUARANTINED ${opts.docId}: [${codes.join(", ")}] — never reaches review.`);
      return { status: "quarantined", docId: opts.docId, unitId: unit.unit_id, errorCodes: codes };
    }

    const entry = submitForReview(unit, {
      reviewQueuePath: paths.reviewQueuePath,
      reviewReceiptsPath: paths.reviewReceiptsPath,
      ...(paths.doctrinePath !== undefined ? { doctrinePath: paths.doctrinePath } : {}),
    });
    say(
      `1 unit(s) submitted for review; run \`node scripts/review.ts list\` to review, ` +
        `then re-run with --publish to publish approved content.`,
    );
    return { status: "submitted", docId: opts.docId, unitId: unit.unit_id, contentHash: entry.content_hash };
  }

  // ---- PUBLISH phase: only validly-approved units publish --------------------
  // Do NOT clear the pipeline dir — review receipts must survive between phases.
  const canon = new CanonStore(opts.canonPath);
  const byId = new Map<string, ReviewQueueEntry>();
  for (const e of readJsonl<ReviewQueueEntry>(paths.reviewQueuePath)) byId.set(e.unit.unit_id, e);
  let entries = [...byId.values()];
  if (opts.docId !== undefined) entries = entries.filter((e) => e.unit.unit_id === opts.docId);

  let translator: ClaudeTranslator | undefined;
  if (langs.length > 0) {
    const key = process.env[ANTHROPIC_API_KEY_ENV];
    if (key === undefined || key.trim() === "") {
      throw new Error(
        `run-pipeline: ${ANTHROPIC_API_KEY_ENV} is required to translate (${langs.join(", ")}).`,
      );
    }
    translator = new ClaudeTranslator();
  }

  const units: Array<{
    unitId: string;
    slug: string;
    english: PublishOutcome;
    translations: Array<{ lang: string; outcome: TranslatedPublishOutcome }>;
  }> = [];
  const skipped: Array<{ unitId: string; reason: string }> = [];
  const pagePaths: string[] = [];

  for (const entry of entries) {
    const unit = entry.unit;
    const status = reviewStatus(unit, { reviewReceiptsPath: paths.reviewReceiptsPath });
    if (status !== "APPROVED") {
      skipped.push({ unitId: unit.unit_id, reason: status });
      say(`SKIP ${unit.unit_id}: ${status}`);
      continue;
    }
    // Re-verify grounding and write the publish queue (now eligible to publish).
    const v = processUnit(unit, canon, paths);
    if (!v.ok) {
      skipped.push({ unitId: unit.unit_id, reason: "GROUNDING_FAILED" });
      say(`SKIP ${unit.unit_id}: grounding failed at publish time`);
      continue;
    }

    const slug = slugForUnit(unit);
    const adapters = [
      new SitePublishAdapter(slug, opts.siteDir),
      ...langs.map((l) => new SitePublishAdapter(`${slug}:${l}`, opts.siteDir)),
    ];
    const env = createEnv(adapters);
    const chain = authorizeRun(env, slug, langs);
    say(
      `governance: authorized run for ${[siteTarget(slug), ...langs.map((l) => siteLangTarget(slug, l))].join(", ")}`,
    );

    const english = await publishPage(unit, env, chain, paths);
    if (english.published) {
      pagePaths.push(english.path);
      say(`PUBLISHED ${siteTarget(slug)} -> ${english.path}`);
    } else {
      say(`BLOCKED ${siteTarget(slug)} [${english.errorCodes.join(", ")}]`);
    }

    const translations: Array<{ lang: string; outcome: TranslatedPublishOutcome }> = [];
    if (langs.length > 0 && translator) {
      for (const lang of langs) {
        const outcome = await publishTranslatedPage(unit, lang, env, chain, paths, translator);
        translations.push({ lang, outcome });
        if (outcome.published) {
          pagePaths.push(outcome.path);
          say(`PUBLISHED ${siteLangTarget(slug, lang)} -> ${outcome.path}`);
        } else if (outcome.reason === "BACK_TRANSLATION_BELOW_THRESHOLD") {
          say(
            `QUARANTINED ${siteLangTarget(slug, lang)} (score=${outcome.score.toFixed(3)} < ${outcome.threshold})`,
          );
        } else {
          say(`BLOCKED ${siteLangTarget(slug, lang)} [${outcome.errorCodes.join(", ")}]`);
        }
      }
    }

    units.push({ unitId: unit.unit_id, slug, english, translations });
  }

  const report = buildCoverageReport({
    publishQueuePath: paths.publishPath,
    publicationsPath: paths.publicationsPath,
    contentQuarantinePath: paths.quarantinePath,
    translationQuarantinePath: paths.translationQuarantinePath,
  });
  const coveragePath = writeCoverageReport(report, opts.siteDir);

  return { status: "published", units, skipped, pagePaths, coveragePath, report };
}

// --- CLI entry (only when run directly, not when imported by a test) ---------

function parseArgs(argv: string[]): { docId: string | undefined; langs: string[]; publish: boolean } {
  const positional = argv[2] !== undefined && !argv[2].startsWith("--") ? argv[2] : undefined;
  const publish = argv.includes("--publish");
  let langs: string[] = [...TIER1_LANGS];
  const i = argv.indexOf("--langs");
  if (i !== -1) {
    const raw = argv[i + 1] ?? "";
    langs = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  return { docId: positional, langs, publish };
}

async function main(): Promise<void> {
  const { docId, langs, publish } = parseArgs(process.argv);

  // The whole run uses the Claude API (content generation + translation), so the
  // key is required up front — fail clearly before doing any work.
  const key = process.env[ANTHROPIC_API_KEY_ENV];
  if (key === undefined || key.trim() === "") {
    console.error(
      `run-pipeline: ${ANTHROPIC_API_KEY_ENV} is required (content generation and ` +
        `translation use the Claude API). Set the API key and re-run.`,
    );
    process.exit(1);
  }

  const canonPath = fileURLToPath(new URL("../data/canon.jsonl", import.meta.url));
  const siteDir = fileURLToPath(new URL("../dist/site", import.meta.url));
  const pipelineDir = fileURLToPath(new URL("../dist/pipeline", import.meta.url));
  const doctrinePath = fileURLToPath(new URL("../DOCTRINE.md", import.meta.url));

  if (!publish) {
    if (docId === undefined) {
      console.error("usage: node scripts/run-pipeline.ts <canon-doc-id> [--langs es,fr,pt] [--publish]");
      process.exit(2);
    }
    let result: PipelineRunResult;
    try {
      result = await runPipeline({
        phase: "submit",
        docId,
        langs,
        canonPath,
        siteDir,
        pipelineDir,
        doctrinePath,
        llm: new ClaudeLlm(),
      });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    if (result.status === "doc-not-found" || result.status === "quarantined") process.exit(1);
    console.log("\nNext:");
    console.log("  node scripts/review.ts list");
    console.log(`  node scripts/review.ts show ${docId}`);
    console.log(`  node scripts/review.ts approve ${docId} --reviewer <name>`);
    console.log(`  node scripts/run-pipeline.ts ${docId} --publish`);
    return;
  }

  let result: PipelineRunResult;
  try {
    result = await runPipeline({
      phase: "publish",
      ...(docId !== undefined ? { docId } : {}),
      langs,
      canonPath,
      siteDir,
      pipelineDir,
      doctrinePath,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (result.status !== "published") process.exit(1);

  console.log("\n--- output ---");
  for (const p of result.pagePaths) console.log(`page:     ${p}`);
  console.log(`coverage: ${result.coveragePath}`);
  for (const s of result.skipped) console.log(`skipped:  ${s.unitId} (${s.reason})`);
  if (result.pagePaths.length === 0) {
    console.log("\nNothing published — approve content first: node scripts/review.ts list");
  } else {
    console.log("\nOpen the coverage dashboard (_coverage.html) and the pages above in a browser.");
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
