/**
 * Human-review gate — makes DOCTRINE.md's promise architectural.
 *
 * Generated content must be reviewed and approved by a human before it can
 * publish. The gate is fail-closed: unreviewed (or rejected, or stale) content
 * cannot reach the publish gateway, exactly the way ungrounded content cannot.
 *
 * Approval is an attested, HASH-BOUND record, not a flag. A ReviewReceipt only
 * authorizes publishing a unit whose CURRENT content hash matches the receipt's
 * `content_hash`. If the content changed after approval, the hashes diverge and
 * it must be re-reviewed — this is the load-bearing property. `content_hash`
 * reuses the Canon Store's NFC SHA-256 hash (canonHash); it is not reinvented.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonHash } from "./canon.ts";
import type { ContentUnit, Hex } from "./types.ts";

export type ReviewDecision = "APPROVED" | "REJECTED";

export interface ReviewReceipt {
  unit_id: string;
  content_hash: Hex; // SHA-256(NFC(reviewed content)) — binds approval to bytes
  decision: ReviewDecision;
  reviewer: string;
  doctrine_version: string; // which DOCTRINE.md standard it was reviewed against
  reason?: string;
  reviewed_at: string; // ISO 8601 UTC
}

export interface ReviewQueueEntry {
  unit: ContentUnit; // the exact bytes submitted for review
  content_hash: Hex;
  doctrine_version: string;
  submitted_at: string;
}

export interface ReviewPaths {
  reviewQueuePath: string;
  reviewReceiptsPath: string;
  doctrinePath?: string;
}

/** Content hash of the exact reviewed bytes — the unit body, NFC SHA-256. */
export function contentHash(unit: ContentUnit): Hex {
  return canonHash(unit.body);
}

/** Doctrine version marker: a short hash of DOCTRINE.md, or "unknown" if absent. */
export function doctrineVersion(doctrinePath?: string): string {
  if (doctrinePath === undefined || !existsSync(doctrinePath)) return "unknown";
  return `sha256:${canonHash(readFileSync(doctrinePath, "utf8")).slice(0, 12)}`;
}

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
 * Submit a grounded unit for human review (pending). It goes to the review
 * queue, NOT the publish path — nothing is publishable until a human approves.
 */
export function submitForReview(unit: ContentUnit, paths: ReviewPaths): ReviewQueueEntry {
  const entry: ReviewQueueEntry = {
    unit,
    content_hash: contentHash(unit),
    doctrine_version: doctrineVersion(paths.doctrinePath),
    submitted_at: new Date().toISOString(),
  };
  appendJsonl(paths.reviewQueuePath, entry);
  return entry;
}

/**
 * Record a human decision as an append-only ReviewReceipt, bound to the exact
 * bytes that were submitted for review (so approval authorizes precisely what
 * the human read). Throws if there is no pending review for the unit.
 */
export function recordReview(
  unit_id: string,
  decision: ReviewDecision,
  reviewer: string,
  reason: string | undefined,
  paths: ReviewPaths,
): ReviewReceipt {
  const pending = readJsonl<ReviewQueueEntry>(paths.reviewQueuePath).filter(
    (e) => e.unit.unit_id === unit_id,
  );
  const latest = pending.at(-1);
  if (!latest) throw new Error(`recordReview: no pending review for unit ${unit_id}`);
  const receipt: ReviewReceipt = {
    unit_id,
    content_hash: latest.content_hash,
    decision,
    reviewer,
    doctrine_version: latest.doctrine_version,
    ...(reason !== undefined ? { reason } : {}),
    reviewed_at: new Date().toISOString(),
  };
  appendJsonl(paths.reviewReceiptsPath, receipt);
  return receipt;
}

export type ReviewStatusCode = "APPROVED" | "REVIEW_REQUIRED" | "REVIEW_REJECTED" | "REVIEW_STALE";

function latestReceiptFor(unit_id: string, reviewReceiptsPath: string): ReviewReceipt | undefined {
  return readJsonl<ReviewReceipt>(reviewReceiptsPath)
    .filter((r) => r.unit_id === unit_id)
    .at(-1);
}

/** Review status of a unit against its CURRENT bytes (latest decision wins). */
export function reviewStatus(
  unit: ContentUnit,
  paths: { reviewReceiptsPath: string },
): ReviewStatusCode {
  const latest = latestReceiptFor(unit.unit_id, paths.reviewReceiptsPath);
  if (!latest) return "REVIEW_REQUIRED"; // never reviewed
  if (latest.decision === "REJECTED") return "REVIEW_REJECTED";
  // APPROVED — but only valid if the content still matches the reviewed bytes.
  return latest.content_hash === contentHash(unit) ? "APPROVED" : "REVIEW_STALE";
}

/**
 * The valid APPROVED receipt for this unit's CURRENT bytes, else null. Returns
 * null for: never reviewed, rejected, or content changed since approval.
 */
export function getApproval(
  unit: ContentUnit,
  paths: { reviewReceiptsPath: string },
): ReviewReceipt | null {
  const latest = latestReceiptFor(unit.unit_id, paths.reviewReceiptsPath);
  if (latest && latest.decision === "APPROVED" && latest.content_hash === contentHash(unit)) {
    return latest;
  }
  return null;
}

export type ReviewBlockCode = Exclude<ReviewStatusCode, "APPROVED">;

/** Thrown when a unit is not validly approved — fail-closed, like QuarantinedUnitRejected. */
export class ReviewBlocked extends Error {
  readonly code: ReviewBlockCode;
  readonly unit_id: string;
  constructor(unit_id: string, code: ReviewBlockCode) {
    super(`unit ${unit_id} blocked at human-review gate: ${code}`);
    this.name = "ReviewBlocked";
    this.code = code;
    this.unit_id = unit_id;
  }
}

/**
 * Fail-closed assertion for the publish path: returns the approving receipt, or
 * throws ReviewBlocked (REVIEW_REQUIRED / REVIEW_REJECTED / REVIEW_STALE).
 */
export function requireApproval(
  unit: ContentUnit,
  paths: { reviewReceiptsPath: string },
): ReviewReceipt {
  const status = reviewStatus(unit, paths);
  if (status !== "APPROVED") throw new ReviewBlocked(unit.unit_id, status);
  // getApproval cannot be null here, but keep it honest.
  const approval = getApproval(unit, paths);
  if (!approval) throw new ReviewBlocked(unit.unit_id, "REVIEW_REQUIRED");
  return approval;
}
