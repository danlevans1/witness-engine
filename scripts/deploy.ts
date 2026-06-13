/**
 * Deploy CLI — publish the gated static site to GitHub Pages, fail-closed.
 *
 *   node scripts/deploy.ts
 *
 * Step 1 (always): verifyDeployable. If ANY page lacks a valid matching review
 * approval, print the blockers and EXIT NONZERO without pushing anything.
 *
 * Step 2 (only if clear): publish dist/site/ to the `gh-pages` branch via a
 * throwaway repo + force push, so the published HTML never lands on `main` and
 * the source tree/history are untouched. The gh-pages branch contains ONLY the
 * site output (plus a `.nojekyll` marker so files like `_coverage.html` — whose
 * leading underscore Jekyll would otherwise hide — are served).
 *
 * This script runs git; it is never imported by the test suite.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isDeployClear, verifyDeployable, type DeployPaths } from "../src/deploy.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(repoRoot, "dist", "site");
const pipelineDir = join(repoRoot, "dist", "pipeline");
const paths: DeployPaths = {
  reviewQueuePath: join(pipelineDir, "review-queue.jsonl"),
  reviewReceiptsPath: join(pipelineDir, "review-receipts.jsonl"),
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function pagesUrl(remoteUrl: string): string | undefined {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return undefined;
  return `https://${m[1]}.github.io/${m[2]}/`;
}

function main(): void {
  // --- Step 1: fail-closed integrity verification --------------------------
  const v = verifyDeployable(distDir, paths);

  for (const f of v.deployable) {
    console.log(v.exempt.includes(f) ? `EXEMPT     ${f} (operator artifact)` : `DEPLOYABLE ${f}`);
  }
  for (const b of v.blocked) console.error(`BLOCKED    ${b.file} (${b.reason})`);

  if (!isDeployClear(v)) {
    console.error(
      `\nrefusing to deploy: ${v.blocked.length} page(s) cannot be traced to a valid ` +
        `review approval. Nothing was pushed.`,
    );
    process.exit(1);
  }

  const contentPages = v.deployable.filter((f) => !v.exempt.includes(f));
  if (contentPages.length === 0) {
    console.error("refusing to deploy: no approved content pages to publish.");
    process.exit(1);
  }

  // --- Step 2: push site-only output to gh-pages ---------------------------
  const remoteUrl = git(["remote", "get-url", "origin"], repoRoot).trim();

  const stage = mkdtempSync(join(tmpdir(), "witness-ghpages-"));
  for (const f of v.deployable) copyFileSync(join(distDir, f), join(stage, f));
  writeFileSync(join(stage, ".nojekyll"), ""); // serve _coverage.html (leading underscore)

  git(["init", "-q"], stage);
  git(["checkout", "-q", "-b", "gh-pages"], stage);
  git(["add", "-A"], stage);
  git(
    ["-c", "user.email=deploy@witness.local", "-c", "user.name=witness-deploy",
      "commit", "-q", "-m", `deploy ${new Date().toISOString()}`],
    stage,
  );
  git(["push", "-f", remoteUrl, "gh-pages"], stage);

  const url = pagesUrl(remoteUrl);
  console.log(`\nDeployed ${contentPages.length} page(s) + coverage to gh-pages.`);
  if (url) {
    console.log(`Pages URL:     ${url}`);
    console.log(`Coverage:      ${url}_coverage.html`);
  } else {
    console.log("(could not derive the Pages URL from the origin remote)");
  }
}

main();
