/**
 * Minimal static-site renderer — Step 2.
 *
 * Pure function: a ContentUnit in, a single self-contained HTML string out.
 * It performs NO I/O. The file write is the SitePublishAdapter's job, and the
 * adapter only ever runs when the PFC gateway invokes it after a passing
 * pre-effect check. Rendering here cannot publish anything.
 *
 * The page is text-first with no external assets (no <script>, <link>, <img>;
 * a single inline <style>), and stays comfortably sub-100KB. It shows the
 * unit body, its source_refs as citations (passage label + short canon hash),
 * and a human-contact / community on-ramp footer — every published page is an
 * on-ramp to people, not an endpoint.
 */
import type { ContentUnit, SourceRef } from "./types.ts";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Best-effort passage label from a canon doc_id, e.g. "web/matthew/5" -> "Matthew 5". */
export function passageLabel(docId: string): string {
  const parts = docId.split("/");
  if (parts.length >= 3) {
    const book = parts[1] ?? "";
    const chapter = parts[2] ?? "";
    const title = book.charAt(0).toUpperCase() + book.slice(1);
    return `${title} ${chapter}`.trim();
  }
  return docId;
}

/** Render body text, preserving paragraph breaks, fully HTML-escaped. */
function renderBodyText(body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (paragraphs.length === 0) return "    <p></p>";
  return paragraphs
    .map((p) => `    <p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Citations: passage + machine-checkable short canon hash for each source_ref. */
export function renderCitations(refs: SourceRef[]): string {
  if (refs.length === 0) return "";
  const items = refs
    .map(
      (r) =>
        `      <li><span class="passage">${escapeHtml(passageLabel(r.doc_id))}</span> ` +
        `<code class="ref">${escapeHtml(r.doc_id)}</code> ` +
        `<span class="hash">canon ${escapeHtml(r.hash.slice(0, 12))}</span></li>`,
    )
    .join("\n");
  return (
    `    <section class="citations" aria-label="Sources">\n` +
    `      <h2>Sources</h2>\n` +
    `      <ul>\n${items}\n      </ul>\n` +
    `    </section>`
  );
}

const ONRAMP_FOOTER =
  `    <footer class="onramp">\n` +
  `      <h2>Take a next step</h2>\n` +
  `      <p>This page is a starting point, not the end. If these words speak to you, ` +
  `you do not have to walk it alone &mdash; ask questions, and find people near you.</p>\n` +
  `      <ul>\n` +
  `        <li>Talk with someone: write to <a href="mailto:hello@witness.example">hello@witness.example</a>.</li>\n` +
  `        <li>Find a local community of people exploring the same questions.</li>\n` +
  `        <li>Keep reading the source text for yourself.</li>\n` +
  `      </ul>\n` +
  `    </footer>`;

const INLINE_CSS =
  "body{font-family:Georgia,serif;line-height:1.6;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}" +
  "h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:2rem}" +
  ".citations code{font-size:.85em;color:#555}.citations .hash{color:#777;font-size:.8em}" +
  ".onramp{margin-top:3rem;border-top:1px solid #ccc;padding-top:1rem;font-size:.95em}";

function titleForText(body: string): string {
  const firstLine = body.split("\n", 1)[0]?.trim() ?? "";
  const base = firstLine === "" ? "A witness" : firstLine;
  return base.length > 80 ? base.slice(0, 77) + "..." : base;
}

interface PageContent {
  lang: string; // BCP-47 — sets the root <html lang> attribute
  body: string; // already-translated (or English) text
  source_refs: SourceRef[]; // citations carried forward (English canon hashes)
}

/** Core renderer: a complete, self-contained HTML page for any language. */
function renderDocument(content: PageContent): string {
  const citations = renderCitations(content.source_refs);
  return (
    [
      `<!doctype html>`,
      `<html lang="${escapeHtml(content.lang)}">`,
      `<head>`,
      `  <meta charset="utf-8">`,
      `  <meta name="viewport" content="width=device-width, initial-scale=1">`,
      `  <title>${escapeHtml(titleForText(content.body))}</title>`,
      `  <style>${INLINE_CSS}</style>`,
      `</head>`,
      `<body>`,
      `  <main>`,
      `    <article class="unit">`,
      renderBodyText(content.body),
      `    </article>`,
      citations,
      `  </main>`,
      ONRAMP_FOOTER,
      `</body>`,
      `</html>`,
      ``,
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n"
  );
}

/** Render a verified ContentUnit to an English page (Step 2 behavior). */
export function renderPage(unit: ContentUnit): string {
  return renderDocument({ lang: "en", body: unit.body, source_refs: unit.source_refs });
}

/**
 * Render a translated page: `lang` on the root element, translated body, and
 * the SAME citation block — translation does not re-ground, so it carries the
 * unit's English source_refs (and their canon hashes) forward.
 */
export function renderTranslatedPage(
  unit: ContentUnit,
  lang: string,
  translatedBody: string,
): string {
  return renderDocument({ lang, body: translatedBody, source_refs: unit.source_refs });
}
