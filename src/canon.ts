/**
 * Canon Store — content-addressed, append-only JSONL store for canonical
 * texts. Each record is a CanonDoc; `hash` is sha256(NFC(text)) and is
 * recomputed (never trusted) at verification time.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonDoc, Hex } from "./types.ts";

/** Canonical content hash: SHA-256 hex of NFC-normalized UTF-8 text. */
export function canonHash(text: string): Hex {
  return createHash("sha256").update(text.normalize("NFC"), "utf8").digest("hex");
}

export class CanonStore {
  readonly #docs = new Map<string, CanonDoc>();
  readonly #filePath: string | undefined;

  /** In-memory store (tests), or file-backed when a path is given. */
  constructor(filePath?: string) {
    this.#filePath = filePath;
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim() !== "");
      for (const line of lines) {
        const doc = JSON.parse(line) as CanonDoc;
        this.#indexOrThrow(doc);
      }
    }
  }

  #indexOrThrow(doc: CanonDoc): void {
    const existing = this.#docs.get(doc.doc_id);
    if (existing && existing.hash !== doc.hash) {
      // Append-only store must fail closed on conflicting re-ingestion.
      throw new Error(`canon conflict: ${doc.doc_id} already stored with a different hash`);
    }
    this.#docs.set(doc.doc_id, doc);
  }

  /** Ingest text: computes the content hash, appends, returns the doc. */
  put(fields: Omit<CanonDoc, "hash">): CanonDoc {
    const doc: CanonDoc = { ...fields, hash: canonHash(fields.text) };
    this.#indexOrThrow(doc);
    if (this.#filePath) {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      appendFileSync(this.#filePath, JSON.stringify(doc) + "\n", "utf8");
    }
    return doc;
  }

  get(docId: string): CanonDoc | undefined {
    return this.#docs.get(docId);
  }

  get size(): number {
    return this.#docs.size;
  }

  [Symbol.iterator](): IterableIterator<CanonDoc> {
    return this.#docs.values();
  }
}
