/**
 * Step 4 — coverage dashboard renderer.
 *
 * BOUNDARY (do not blur): this renders a report ABOUT the system — an
 * operator/reader artifact — NOT gospel content. It is therefore deliberately
 * NOT a gated publish: it does not pass through the PFC ConnectorGateway and
 * has no BoundaryReceipt. Gospel pages are written ONLY by SitePublishAdapter
 * after a passing pre-effect check; this dashboard is written directly by
 * `writeCoverageReport` on purpose. The `_coverage.html` filename (underscore
 * prefix) marks it as a meta/operator file, distinct from published pages, and
 * it must never carry or be confused with published gospel content.
 *
 * Text-first, no external assets, consistent with src/site.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TARGET_LANGUAGES,
  type CoverageReport,
  type LanguageCoverage,
  type UnitCoverage,
} from "./ledger.ts";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const INLINE_CSS =
  "body{font-family:Georgia,serif;line-height:1.5;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}" +
  "h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:2rem}" +
  "table{border-collapse:collapse;width:100%;font-size:.92em}" +
  "th,td{border:1px solid #ccc;padding:.35rem .5rem;text-align:left;vertical-align:top}" +
  "th{background:#f4f4f4}" +
  ".published{color:#1a6b2f}.gap{color:#8a4b00}.cq{color:#9b1c1c}" +
  ".score{color:#555;font-size:.85em}" +
  ".engagement{margin-top:2.5rem;border-top:1px solid #ccc;padding-top:1rem;color:#444}" +
  ".empty{font-style:italic;color:#777}";

function cellHtml(cov: LanguageCoverage): string {
  if (cov.status === "PUBLISHED") {
    return `<td class="published">published</td>`;
  }
  const score = cov.score !== undefined ? ` <span class="score">(score ${cov.score.toFixed(3)})</span>` : "";
  return `<td class="gap">gap: ${escapeHtml(cov.gapType)}<br><span class="score">${escapeHtml(cov.reason)}</span>${score}</td>`;
}

function unitRow(u: UnitCoverage): string {
  const label = u.contentQuarantined
    ? `<td class="cq">${escapeHtml(u.unit_id)}<br><span class="score">content-quarantined: ${escapeHtml(u.contentQuarantineCodes.join(", "))}</span></td>`
    : `<td>${escapeHtml(u.unit_id)}</td>`;
  const cells = TARGET_LANGUAGES.map((l) => cellHtml(u.languages[l])).join("");
  return `      <tr>${label}${cells}</tr>`;
}

/** Render the coverage report to a self-contained HTML dashboard. */
export function renderCoverageReport(report: CoverageReport): string {
  const headLangs = TARGET_LANGUAGES.map((l) => `<th>${escapeHtml(l)}</th>`).join("");
  const rows = report.units.map(unitRow).join("\n");
  const r = report.rollups;
  const perLang = TARGET_LANGUAGES.map(
    (l) => `<li><strong>${escapeHtml(l)}</strong>: ${r.publishedByLanguage[l]} published, ${r.gapsByLanguage[l]} gap(s)</li>`,
  ).join("\n      ");

  return (
    [
      `<!doctype html>`,
      `<html lang="en">`,
      `<head>`,
      `  <meta charset="utf-8">`,
      `  <meta name="viewport" content="width=device-width, initial-scale=1">`,
      `  <title>Witness Ledger — coverage report</title>`,
      `  <style>${INLINE_CSS}</style>`,
      `</head>`,
      `<body>`,
      `  <main>`,
      `    <h1>Witness Ledger — coverage report</h1>`,
      `    <p>Operator/reader artifact about the system. This is <strong>not</strong> published gospel content and does not pass through the publication gateway.</p>`,
      `    <h2>Coverage by unit and language</h2>`,
      `    <table>`,
      `      <thead><tr><th>unit</th>${headLangs}</tr></thead>`,
      `      <tbody>`,
      rows,
      `      </tbody>`,
      `    </table>`,
      `    <h2>Summary</h2>`,
      `    <ul>`,
      `      <li>Total units: ${r.totalUnits}</li>`,
      `      <li>Content-quarantined units (never grounded): ${r.contentQuarantinedUnits}</li>`,
      `      <li>Units published in English: ${r.unitsPublishedInEnglish}</li>`,
      `      ${perLang}`,
      `      <li>Languages with ≥1 published unit: ${
        r.languagesWithPublications.length > 0 ? escapeHtml(r.languagesWithPublications.join(", ")) : "none"
      }</li>`,
      `    </ul>`,
      `    <section class="engagement">`,
      `      <h2>Engagement (not yet measured)</h2>`,
      `      <p class="empty">${escapeHtml(report.engagement.note)}</p>`,
      `      <p class="empty">People-group engagement records: ${report.engagement.byPeopleGroup.length} (none collected at v0.1).</p>`,
      `    </section>`,
      `  </main>`,
      `</body>`,
      `</html>`,
      ``,
    ].join("\n") + "\n"
  );
}

/**
 * Write the coverage dashboard to <outDir>/_coverage.html. NOT a gated publish
 * (see file header) — this is an operator artifact, written directly.
 */
export function writeCoverageReport(report: CoverageReport, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "_coverage.html");
  writeFileSync(path, renderCoverageReport(report), "utf8");
  return path;
}
