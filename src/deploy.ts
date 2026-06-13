/**
 * Deploy integrity gate — fail-closed mirroring, not blind mirroring.
 *
 * Deploy does NOT go through the publish gateway: the files in dist/site/ were
 * already grounded + reviewed + authorized by the publish path (the only writer
 * of gospel pages). But before anything is pushed live, deploy must VERIFY: for
 * every content page, a valid review receipt must exist whose content_hash
 * matches the published content. Any page that cannot be traced to a valid
 * approval is a deploy-blocker — never silently pushed. This is what stops a
 * hand-dropped or post-approval-tampered file from going live.
 *
 * Tracing reuses the existing review records (no new conventions): a page file
 * `<slug>.html` / `<slug>.<lang>.html` maps back to its source unit (the review
 * queue stores the exact reviewed unit), and that unit must still satisfy
 * getApproval — i.e. the latest receipt is APPROVED and its content_hash still
 * equals the unit's content hash. Translations trace to the SOURCE unit's
 * approval, exactly as the publish gate treats them.
 *
 * The coverage dashboard (_coverage.html) is an operator artifact, exempt from
 * the receipt check (and clearly reported as such).
 *
 * Pure-ish: reads files + receipt/queue JSONL. No network.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { getApproval, type ReviewQueueEntry } from "./review.ts";
import { slugForUnit } from "./publish.ts";
import { isTier1Lang } from "./translate.ts";
import type { ContentUnit } from "./types.ts";

export interface DeployPaths {
  reviewQueuePath: string;
  reviewReceiptsPath: string;
}

export interface DeployBlock {
  file: string;
  reason: "UNRECOGNIZED_FILENAME" | "NO_SOURCE_UNIT" | "NO_VALID_APPROVAL";
}

export interface DeployVerification {
  deployable: string[]; // filenames safe to deploy (approved pages + exempt artifacts)
  blocked: DeployBlock[]; // pages that must NOT be deployed
  exempt: string[]; // operator artifacts deployed without a receipt check
}

/** Operator artifacts exempt from the receipt check (not gospel content). */
export const EXEMPT_FILES: ReadonlySet<string> = new Set(["_coverage.html"]);

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

/** Parse a page filename into { slug, lang }, or null if it isn't a page. */
export function parsePageName(file: string): { slug: string; lang: string } | null {
  if (!file.endsWith(".html")) return null;
  const base = file.slice(0, -".html".length);
  const parts = base.split("."); // slugs never contain "." (slugForUnit strips them)
  const slug = parts[0];
  if (slug === undefined || slug === "") return null;
  if (parts.length === 1) return { slug, lang: "en" };
  const lang = parts[1];
  if (parts.length === 2 && lang !== undefined && isTier1Lang(lang)) return { slug, lang };
  return null;
}

/**
 * Verify which pages in `distDir` may be deployed. A content page is deployable
 * only if it traces to a source unit with a valid, hash-matching approval.
 */
export function verifyDeployable(distDir: string, paths: DeployPaths): DeployVerification {
  const deployable: string[] = [];
  const blocked: DeployBlock[] = [];
  const exempt: string[] = [];

  // slug -> source unit (latest queue entry per unit_id wins).
  const unitBySlug = new Map<string, ContentUnit>();
  for (const e of readJsonl<ReviewQueueEntry>(paths.reviewQueuePath)) {
    unitBySlug.set(slugForUnit(e.unit), e.unit);
  }

  const files = existsSync(distDir)
    ? readdirSync(distDir).filter((f) => f.endsWith(".html")).sort()
    : [];

  for (const file of files) {
    if (EXEMPT_FILES.has(file)) {
      exempt.push(file);
      deployable.push(file); // operator artifact — deployed, not receipt-checked
      continue;
    }
    const parsed = parsePageName(file);
    if (!parsed) {
      blocked.push({ file, reason: "UNRECOGNIZED_FILENAME" });
      continue;
    }
    const unit = unitBySlug.get(parsed.slug);
    if (!unit) {
      // No reviewed unit produced this page: hand-dropped / unprovenanced.
      blocked.push({ file, reason: "NO_SOURCE_UNIT" });
      continue;
    }
    const approval = getApproval(unit, { reviewReceiptsPath: paths.reviewReceiptsPath });
    if (!approval) {
      // Never approved, rejected, or content changed since approval (stale).
      blocked.push({ file, reason: "NO_VALID_APPROVAL" });
      continue;
    }
    deployable.push(file);
  }

  return { deployable, blocked, exempt };
}

/** Fail-closed gate used by the CLI: deploy only when nothing is blocked. */
export function isDeployClear(v: DeployVerification): boolean {
  return v.blocked.length === 0;
}
