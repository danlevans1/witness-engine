/**
 * Verification pass — fail-closed gate between the Content Engine and the
 * publish queue.
 *
 * Every source_ref must (a) resolve in the Canon Store and (b) carry a
 * hash equal to the hash RECOMPUTED from the stored canon text. The stored
 * `hash` field is never trusted: recomputing detects both fabricated
 * citations and post-ingestion tampering of canon text. Zero refs is an
 * automatic refusal — uncited content never publishes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonHash, type CanonStore } from "./canon.ts";
import type {
  ContentUnit,
  PublishRecord,
  QuarantineRecord,
  VerifyError,
  VerifyResult,
} from "./types.ts";

export function verifyUnit(unit: ContentUnit, canon: CanonStore): VerifyResult {
  const errors: VerifyError[] = [];

  if (unit.source_refs.length === 0) {
    errors.push({
      code: "EMPTY_SOURCE_REFS",
      detail: "unit cites nothing; fail-closed refusal",
    });
  }

  for (const ref of unit.source_refs) {
    const doc = canon.get(ref.doc_id);
    if (!doc) {
      errors.push({
        code: "UNRESOLVED_REF",
        doc_id: ref.doc_id,
        detail: `no canon doc with id ${ref.doc_id}`,
      });
      continue;
    }
    const recomputed = canonHash(doc.text);
    if (recomputed !== ref.hash) {
      errors.push({
        code: "HASH_MISMATCH",
        doc_id: ref.doc_id,
        detail:
          recomputed === doc.hash
            ? `ref hash ${ref.hash.slice(0, 12)}… does not match canon text`
            : `canon text for ${ref.doc_id} fails its own stored hash (tampering)`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export interface PipelinePaths {
  publishPath: string;
  quarantinePath: string;
}

function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Route a unit: publish queue on pass, quarantine JSONL on any failure.
 * Returns the verification result so callers can report.
 */
export function processUnit(
  unit: ContentUnit,
  canon: CanonStore,
  paths: PipelinePaths,
): VerifyResult {
  const result = verifyUnit(unit, canon);
  const now = new Date().toISOString();
  if (result.ok) {
    const record: PublishRecord = { unit, verifiedAt: now };
    appendJsonl(paths.publishPath, record);
  } else {
    const record: QuarantineRecord = { unit, errors: result.errors, quarantinedAt: now };
    appendJsonl(paths.quarantinePath, record);
  }
  return result;
}
