/**
 * Step 2 — static-site publisher gated by the PFC ConnectorGateway.
 *
 * The governance boundary is NOT in this file. Publishing is modeled as a
 * connector call: witness-engine never writes a page directly. It asks the
 * imported `ConnectorGateway` to execute a `publish` action on target
 * `site:<slug>`, presenting a delegation chain that authorizes exactly that
 * action+target. The gateway runs its pre-effect check and decides:
 *
 *   - PASS  -> it issues a PRE_EFFECT BoundaryReceipt and invokes the
 *              SitePublishAdapter, whose effect (render + file write) is the
 *              ONLY place a page is written; then an ExecutionResultReceipt.
 *   - FAIL  -> it issues a BLOCKED BoundaryReceipt and returns a refusal;
 *              the adapter is never reached, so no file is written.
 *
 * No chain/gateway logic is reimplemented here — it is all imported from
 * pfc-connector-gateway-proof (v0.3.0).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  AGENT_A,
  AGENT_B,
  FRESHNESS_DEFAULTS,
  issueDelegationToken,
  issueHumanAuthReceipt,
} from "pfc-connector-gateway-proof";
import type {
  ChainVerificationErrorCode,
  ConnectorAdapter,
  ConnectorCall,
  DelegationToken,
  Env,
  GatewayExecution,
  GatewayRefusal,
  ToolScope,
} from "pfc-connector-gateway-proof";

import { renderPage, renderTranslatedPage } from "./site.ts";
import { backTranslationCheck, StubTranslator, type Translator } from "./translate.ts";
import type { ContentUnit, PublicationRecord } from "./types.ts";

const SITE_CONNECTOR = "site";

/** Scope helpers — the canonical action/target strings for a slug. */
export function siteTarget(slug: string): string {
  return `${SITE_CONNECTOR}:${slug}`;
}
export function publishAction(slug: string): string {
  // Gateway scope model: callAction(call) === `${tool}.${operation}`.
  return `${slug}.publish`;
}

/** Deterministic, filesystem-safe slug for a unit. */
export function slugForUnit(unit: ContentUnit): string {
  const s = unit.unit_id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "page" : s;
}

/** Thrown when a unit is in the quarantine ledger — before the gateway is touched. */
export class QuarantinedUnitRejected extends Error {
  readonly unit_id: string;
  constructor(unitId: string) {
    super(`unit ${unitId} is quarantined; refusing to publish`);
    this.name = "QuarantinedUnitRejected";
    this.unit_id = unitId;
  }
}

/** Thrown when a unit was never admitted to the publish queue. */
export class UnitNotInPublishQueue extends Error {
  readonly unit_id: string;
  constructor(unitId: string) {
    super(`unit ${unitId} is not in the publish queue; refusing to publish`);
    this.name = "UnitNotInPublishQueue";
    this.unit_id = unitId;
  }
}

export interface SitePublishResult {
  slug: string;
  path: string;
  bytes: number;
}

/**
 * The connector whose effect is publishing a page. Its connector/tool resolve
 * to the gateway target `site:<slug>` (callTarget === `${connector}:${tool}`),
 * so the gateway routes a `site:<slug>` call here — and ONLY after a passing
 * pre-effect check. The single `writeFileSync` below is the sole writer of a
 * page to disk.
 */
export class SitePublishAdapter implements ConnectorAdapter {
  readonly connector = SITE_CONNECTOR;
  readonly tool: string; // = slug
  readonly #outDir: string;

  constructor(slug: string, outDir: string) {
    this.tool = slug;
    this.#outDir = outDir;
  }

  async invoke(operation: string, payload: unknown): Promise<SitePublishResult> {
    if (operation !== "publish") {
      throw new Error(`SitePublishAdapter: unsupported operation ${operation}`);
    }
    const { unit, lang, translatedBody } = payload as {
      unit: ContentUnit;
      lang?: string;
      translatedBody?: string;
    };
    const html =
      lang !== undefined && translatedBody !== undefined
        ? renderTranslatedPage(unit, lang, translatedBody)
        : renderPage(unit);
    mkdirSync(this.#outDir, { recursive: true });
    // tool "matthew-5" -> "matthew-5.html"; "matthew-5:es" -> "matthew-5.es.html".
    const fileName = `${this.tool.replace(/:/g, ".")}.html`;
    const path = join(this.#outDir, fileName);
    writeFileSync(path, html, "utf8"); // <-- only gated, gateway-invoked write
    return { slug: this.tool, path, bytes: Buffer.byteLength(html, "utf8") };
  }
}

/**
 * Build a delegation chain (HumanAuthReceipt -> DelegationToken) that
 * authorizes exactly `publish` on `site:<slug>` and nothing else. Issued
 * through the imported issuance builders against the env's keys/config.
 */
export function authorizeSitePublish(env: Env, slug: string): DelegationToken {
  const scope: ToolScope = {
    permittedTargets: [siteTarget(slug)],
    permittedActions: [publishAction(slug)],
  };
  const receipt = issueHumanAuthReceipt({
    governanceKey: env.keys.governance,
    grantedBy: "human:dan@example.com",
    authorizedAgent: AGENT_A,
    scope,
    usagePolicy: "MULTI_USE",
    maxUses: 100,
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

export interface PublishQueuePaths {
  publishPath: string;
  quarantinePath: string;
  /** Where back-translation gate failures are recorded. Defaults to
   *  translation-quarantine.jsonl beside quarantinePath. */
  translationQuarantinePath?: string;
  /** Where successful publishes are recorded (one per language version),
   *  derived from the gateway's ExecutionResultReceipt. Read by the Witness
   *  Ledger (Step 4). When unset, no publication record is written. */
  publicationsPath?: string;
}

/** Append a publication record (proof-of-publish) when a publications path is set. */
function recordPublication(
  paths: PublishQueuePaths,
  rec: PublicationRecord,
): void {
  if (paths.publicationsPath === undefined) return;
  mkdirSync(dirname(paths.publicationsPath), { recursive: true });
  appendFileSync(paths.publicationsPath, JSON.stringify(rec) + "\n", "utf8");
}

export type PublishOutcome =
  | { published: true; slug: string; path: string; execution: GatewayExecution }
  | {
      published: false;
      slug: string;
      refusal: GatewayRefusal;
      errorCodes: ChainVerificationErrorCode[];
    };

/** Collect unit_ids recorded in a pipeline JSONL ({ unit: { unit_id } } per line). */
function unitIdsIn(path: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(path)) return ids;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const rec = JSON.parse(t) as { unit?: { unit_id?: string } };
      if (rec.unit?.unit_id) ids.add(rec.unit.unit_id);
    } catch {
      // ignore malformed lines — fail closed by simply not matching
    }
  }
  return ids;
}

/**
 * Publish one verified unit as a static page — but only if the gateway allows.
 *
 *   1. Quarantine gate: if the unit_id is in the quarantine JSONL, throw
 *      QuarantinedUnitRejected BEFORE the gateway is ever called.
 *   2. Pull only from the publish queue: the unit must be present in the
 *      publish JSONL (a Step-1 verified unit), else UnitNotInPublishQueue.
 *   3. Ask the gateway to execute `publish` on `site:<slug>` with `chain`.
 *      On refusal: write nothing, log the codes, return the blocked outcome.
 *      On execution: the adapter has already written the page.
 */
export async function publishPage(
  unit: ContentUnit,
  env: Env,
  chain: DelegationToken,
  paths: PublishQueuePaths,
): Promise<PublishOutcome> {
  // 1. Quarantine gate — never touch the gateway for a quarantined unit.
  if (unitIdsIn(paths.quarantinePath).has(unit.unit_id)) {
    throw new QuarantinedUnitRejected(unit.unit_id);
  }
  // 2. Only verified, queued units are eligible.
  if (!unitIdsIn(paths.publishPath).has(unit.unit_id)) {
    throw new UnitNotInPublishQueue(unit.unit_id);
  }

  const slug = slugForUnit(unit);
  const call: ConnectorCall = {
    connector: SITE_CONNECTOR,
    tool: slug,
    operation: "publish",
    payload: { unit },
  };

  // 3. The gateway decides whether the adapter fires. witness-engine does not
  //    write the page itself.
  const outcome = await env.gateway.execute(chain, call, "publish");

  if (!outcome.ok) {
    const errorCodes = outcome.verification.errors.map((e) => e.code);
    console.error(
      `[witness] publish BLOCKED ${siteTarget(slug)} (${publishAction(slug)}): ` +
        `[${errorCodes.join(", ")}] boundary=${outcome.boundaryReceipt.receiptId} ` +
        `status=${outcome.boundaryReceipt.status}`,
    );
    return { published: false, slug, refusal: outcome, errorCodes };
  }

  const result = outcome.result as SitePublishResult;
  recordPublication(paths, {
    unit_id: unit.unit_id,
    lang: "en",
    target: siteTarget(slug),
    receiptId: outcome.executionResultReceipt.receiptId,
    publishedAt: new Date().toISOString(),
  });
  return { published: true, slug, path: result.path, execution: outcome };
}

// ===========================================================================
// Step 3 — translated pages: each language is its own gated publish.
// ===========================================================================

/** Gateway target / action strings for a language version of a slug. */
export function siteLangTarget(slug: string, lang: string): string {
  return `${SITE_CONNECTOR}:${slug}:${lang}`;
}
export function publishLangAction(slug: string, lang: string): string {
  // callAction === `${tool}.${operation}`, tool === `${slug}:${lang}`.
  return `${slug}:${lang}.publish`;
}

/**
 * Authorize publishing one or more language versions of a slug. The chain
 * authorizes exactly those `site:<slug>:<lang>` targets and their publish
 * actions — nothing else.
 */
export function authorizeTranslatedPublish(
  env: Env,
  slug: string,
  langs: string[],
): DelegationToken {
  const scope: ToolScope = {
    permittedTargets: langs.map((l) => siteLangTarget(slug, l)),
    permittedActions: langs.map((l) => publishLangAction(slug, l)),
  };
  const receipt = issueHumanAuthReceipt({
    governanceKey: env.keys.governance,
    grantedBy: "human:dan@example.com",
    authorizedAgent: AGENT_A,
    scope,
    usagePolicy: "MULTI_USE",
    maxUses: 100,
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

export interface TranslationQuarantineRecord {
  unit_id: string;
  lang: string;
  score: number;
  threshold: number;
  reason: "BACK_TRANSLATION_BELOW_THRESHOLD";
  quarantinedAt: string;
}

export type TranslatedPublishOutcome =
  | { published: true; lang: string; slug: string; path: string; execution: GatewayExecution }
  | {
      published: false;
      lang: string;
      slug: string;
      reason: "BACK_TRANSLATION_BELOW_THRESHOLD";
      score: number;
      threshold: number;
    }
  | {
      published: false;
      lang: string;
      slug: string;
      reason: "GATEWAY_REFUSAL";
      refusal: GatewayRefusal;
      errorCodes: ChainVerificationErrorCode[];
    };

function translationQuarantinePathFor(paths: PublishQueuePaths): string {
  return (
    paths.translationQuarantinePath ??
    join(dirname(paths.quarantinePath), "translation-quarantine.jsonl")
  );
}

/**
 * Publish a translated language version of a verified unit — still a gated
 * publish. The flow:
 *   1. Same pre-checks as Step 2: quarantined units are refused before the
 *      gateway; only publish-queue units are eligible.
 *   2. Translate en->lang and run the back-translation quality gate. Below
 *      QUALITY_THRESHOLD -> append a translation-quarantine record and write
 *      NOTHING (honest gap over bad coverage); the gateway is never called.
 *   3. On gate pass, ask the gateway to execute `publish` on
 *      `site:<slug>:<lang>` with `chain`. Refusal -> fail closed, no file.
 *      Execution -> the adapter has written dist/site/<slug>.<lang>.html.
 */
export async function publishTranslatedPage(
  unit: ContentUnit,
  lang: string,
  env: Env,
  chain: DelegationToken,
  paths: PublishQueuePaths,
  translator: Translator = new StubTranslator(),
): Promise<TranslatedPublishOutcome> {
  const slug = slugForUnit(unit);

  // 1. Same admission rules as the English publish path.
  if (unitIdsIn(paths.quarantinePath).has(unit.unit_id)) {
    throw new QuarantinedUnitRejected(unit.unit_id);
  }
  if (!unitIdsIn(paths.publishPath).has(unit.unit_id)) {
    throw new UnitNotInPublishQueue(unit.unit_id);
  }

  // 2. Back-translation quality gate — fail closed into translation quarantine.
  const check = backTranslationCheck(translator, unit.body, lang);
  if (!check.pass) {
    const record: TranslationQuarantineRecord = {
      unit_id: unit.unit_id,
      lang,
      score: check.score,
      threshold: check.threshold,
      reason: "BACK_TRANSLATION_BELOW_THRESHOLD",
      quarantinedAt: new Date().toISOString(),
    };
    const qPath = translationQuarantinePathFor(paths);
    mkdirSync(dirname(qPath), { recursive: true });
    appendFileSync(qPath, JSON.stringify(record) + "\n", "utf8");
    console.error(
      `[witness] translation BELOW THRESHOLD ${siteLangTarget(slug, lang)}: ` +
        `score=${check.score.toFixed(3)} < ${check.threshold} -> quarantined, no publish`,
    );
    return {
      published: false,
      lang,
      slug,
      reason: "BACK_TRANSLATION_BELOW_THRESHOLD",
      score: check.score,
      threshold: check.threshold,
    };
  }

  // 3. Gated publish of the language version.
  const call: ConnectorCall = {
    connector: SITE_CONNECTOR,
    tool: `${slug}:${lang}`,
    operation: "publish",
    payload: { unit, lang, translatedBody: check.target },
  };
  const outcome = await env.gateway.execute(chain, call, `publish:${lang}`);

  if (!outcome.ok) {
    const errorCodes = outcome.verification.errors.map((e) => e.code);
    console.error(
      `[witness] translated publish BLOCKED ${siteLangTarget(slug, lang)} ` +
        `(${publishLangAction(slug, lang)}): [${errorCodes.join(", ")}] ` +
        `boundary=${outcome.boundaryReceipt.receiptId} status=${outcome.boundaryReceipt.status}`,
    );
    return { published: false, lang, slug, reason: "GATEWAY_REFUSAL", refusal: outcome, errorCodes };
  }

  const result = outcome.result as SitePublishResult;
  recordPublication(paths, {
    unit_id: unit.unit_id,
    lang,
    target: siteLangTarget(slug, lang),
    receiptId: outcome.executionResultReceipt.receiptId,
    publishedAt: new Date().toISOString(),
  });
  return { published: true, lang, slug, path: result.path, execution: outcome };
}
