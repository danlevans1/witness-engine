/**
 * Seed the Canon Store with the Gospel of Matthew, World English Bible
 * (public domain), at book/chapter granularity: doc_id "web/matthew/{n}".
 *
 * Source: the `world-english-bible` npm package (verse-level JSON derived
 * from the official WEB HTML). Chapter text is rebuilt deterministically:
 * one line per verse, "{verse} {text}", segments of a split verse joined
 * with a single space, whitespace collapsed.
 *
 * Idempotent: re-running against an existing canon.jsonl re-ingests the
 * same text → same hashes; a conflicting hash for an existing doc_id throws
 * (append-only store fails closed).
 */
import { readFileSync } from "node:fs";
import { CanonStore } from "../src/canon.ts";

interface WebEntry {
  type: string;
  chapterNumber?: number;
  verseNumber?: number;
  value?: string;
}

const CANON_PATH = new URL("../data/canon.jsonl", import.meta.url).pathname;
const SOURCE = new URL(
  "../node_modules/world-english-bible/json/matthew.json",
  import.meta.url,
).pathname;

const entries = JSON.parse(readFileSync(SOURCE, "utf8")) as WebEntry[];

// chapter -> verse -> text segments (in document order)
const chapters = new Map<number, Map<number, string[]>>();
for (const e of entries) {
  if (e.chapterNumber === undefined || e.verseNumber === undefined || !e.value) continue;
  if (e.type !== "paragraph text" && e.type !== "line text") continue;
  const verses = chapters.get(e.chapterNumber) ?? new Map<number, string[]>();
  const segs = verses.get(e.verseNumber) ?? [];
  segs.push(e.value);
  verses.set(e.verseNumber, segs);
  chapters.set(e.chapterNumber, verses);
}

const store = new CanonStore(CANON_PATH);
let ingested = 0;
for (const chapter of [...chapters.keys()].sort((a, b) => a - b)) {
  const verses = chapters.get(chapter)!;
  const text = [...verses.keys()]
    .sort((a, b) => a - b)
    .map((v) => `${v} ${verses.get(v)!.join(" ").replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const existing = store.get(`web/matthew/${chapter}`);
  if (existing) continue; // already seeded
  store.put({ doc_id: `web/matthew/${chapter}`, version: "WEB", lang: "en", text });
  ingested++;
}

console.log(`canon store: ${store.size} docs (${ingested} newly ingested) → ${CANON_PATH}`);
const sample = store.get("web/matthew/5");
console.log(`sample web/matthew/5 hash: ${sample?.hash}`);
console.log(`sample first line: ${sample?.text.split("\n", 1)[0]}`);
