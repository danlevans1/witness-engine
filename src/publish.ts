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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

import { renderPage } from "./site.ts";
import type { ContentUnit } from "./types.ts";

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
    const { unit } = payload as { unit: ContentUnit };
    const html = renderPage(unit);
    mkdirSync(this.#outDir, { recursive: true });
    const path = join(this.#outDir, `${this.tool}.html`);
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
  return { published: true, slug, path: result.path, execution: outcome };
}
