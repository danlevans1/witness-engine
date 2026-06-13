/**
 * Human-review CLI for the witness-engine review queue.
 *
 *   node scripts/review.ts list
 *   node scripts/review.ts show <unit_id>
 *   node scripts/review.ts approve <unit_id> --reviewer <name>
 *   node scripts/review.ts reject  <unit_id> --reviewer <name> --reason <text>
 *
 * Reviewers read the exact submitted bytes (`show`) and record an attested,
 * hash-bound ReviewReceipt (`approve`/`reject`). An approval authorizes
 * publishing ONLY content whose hash still matches what was reviewed.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  recordReview,
  reviewStatus,
  type ReviewPaths,
  type ReviewQueueEntry,
} from "../src/review.ts";

const pipelineDir = fileURLToPath(new URL("../dist/pipeline", import.meta.url));
const paths: ReviewPaths = {
  reviewQueuePath: `${pipelineDir}/review-queue.jsonl`,
  reviewReceiptsPath: `${pipelineDir}/review-receipts.jsonl`,
  doctrinePath: fileURLToPath(new URL("../DOCTRINE.md", import.meta.url)),
};

function readQueue(): ReviewQueueEntry[] {
  if (!existsSync(paths.reviewQueuePath)) return [];
  return readFileSync(paths.reviewQueuePath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ReviewQueueEntry);
}

function latestPerUnit(): ReviewQueueEntry[] {
  const m = new Map<string, ReviewQueueEntry>();
  for (const e of readQueue()) m.set(e.unit.unit_id, e);
  return [...m.values()];
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const cmd = process.argv[2];

  if (cmd === "list") {
    const entries = latestPerUnit();
    if (entries.length === 0) {
      console.log("review queue is empty.");
      return;
    }
    for (const e of entries) {
      const status = reviewStatus(e.unit, paths);
      const oneLine = e.unit.body.replace(/\s+/g, " ").trim();
      const preview = oneLine.slice(0, 80) + (oneLine.length > 80 ? "…" : "");
      console.log(`${e.unit.unit_id}  [${status}]  ${e.content_hash.slice(0, 12)}  "${preview}"`);
    }
    return;
  }

  if (cmd === "show") {
    const id = process.argv[3];
    if (id === undefined) {
      console.error("usage: review.ts show <unit_id>");
      process.exit(2);
    }
    const e = latestPerUnit().find((x) => x.unit.unit_id === id);
    if (!e) {
      console.error(`no pending review for ${id}`);
      process.exit(1);
    }
    console.log(`unit_id:          ${e.unit.unit_id}`);
    console.log(`content_hash:     ${e.content_hash}`);
    console.log(`doctrine_version: ${e.doctrine_version}`);
    console.log(`status:           ${reviewStatus(e.unit, paths)}`);
    console.log(`submitted_at:     ${e.submitted_at}`);
    console.log(`\n---- content ----\n${e.unit.body}\n-----------------`);
    return;
  }

  if (cmd === "approve" || cmd === "reject") {
    const id = process.argv[3];
    const reviewer = flag("reviewer");
    if (id === undefined || reviewer === undefined || reviewer.trim() === "") {
      console.error(
        `usage: review.ts ${cmd} <unit_id> --reviewer <name>` +
          (cmd === "reject" ? " --reason <text>" : ""),
      );
      process.exit(2);
    }
    const reason = flag("reason");
    if (cmd === "reject" && (reason === undefined || reason.trim() === "")) {
      console.error("reject requires --reason <text>");
      process.exit(2);
    }
    try {
      const receipt = recordReview(
        id,
        cmd === "approve" ? "APPROVED" : "REJECTED",
        reviewer,
        reason,
        paths,
      );
      console.log(
        `${receipt.decision} ${id} by ${reviewer} ` +
          `(content ${receipt.content_hash.slice(0, 12)}, doctrine ${receipt.doctrine_version})`,
      );
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    return;
  }

  console.error("usage: review.ts <list|show|approve|reject> [...]");
  process.exit(2);
}

main();
