/**
 * Witness Engine — step 1 types.
 *
 * Canon docs are content-addressed: `hash` is the SHA-256 (hex) of the
 * NFC-normalized UTF-8 text. A content unit may only cite canon docs, and
 * every citation must carry both the doc_id and the hash it was grounded
 * against. Verification is fail-closed: anything unresolved, mismatched,
 * or uncited goes to quarantine — never the publish queue.
 */

export type Hex = string; // lowercase hex

/** One canonical text unit (book/chapter granularity for scripture). */
export interface CanonDoc {
  doc_id: string; // e.g. "web/matthew/5"
  hash: Hex; // sha256(NFC(text))
  version: string; // e.g. "WEB" (World English Bible)
  lang: string; // BCP-47, e.g. "en"
  text: string;
}

/** A citation from a content unit into the canon. */
export interface SourceRef {
  doc_id: string;
  hash: Hex; // hash the unit claims it was grounded against
}

export type UnitFormat = "markdown" | "plain";

/** Output of the Content Engine. */
export interface ContentUnit {
  unit_id: string;
  source_refs: SourceRef[];
  body: string;
  format: UnitFormat;
}

export type VerifyErrorCode =
  | "EMPTY_SOURCE_REFS" // fail-closed: uncited content never publishes
  | "UNRESOLVED_REF" // doc_id not present in the Canon Store
  | "HASH_MISMATCH"; // ref hash ≠ recomputed hash of stored canon text

export interface VerifyError {
  code: VerifyErrorCode;
  doc_id?: string;
  detail: string;
}

export interface VerifyResult {
  ok: boolean; // true only when errors is empty
  errors: VerifyError[];
}

/** Quarantine record — the unit plus why it was refused. */
export interface QuarantineRecord {
  unit: ContentUnit;
  errors: VerifyError[];
  quarantinedAt: string; // ISO 8601 UTC
}

/** Publish-queue record. */
export interface PublishRecord {
  unit: ContentUnit;
  verifiedAt: string; // ISO 8601 UTC
}

/**
 * Publication record — proof that a page actually published, derived from the
 * gateway's ExecutionResultReceipt (NOT from the rendered file). One record per
 * successful language version. This is the source of truth the Witness Ledger
 * reads for "published in language X".
 */
export interface PublicationRecord {
  unit_id: string;
  lang: string; // BCP-47; "en" for the English page
  target: string; // gateway target, e.g. "site:matthew-5:es"
  receiptId: string; // ExecutionResultReceipt id
  publishedAt: string; // ISO 8601 UTC
}
