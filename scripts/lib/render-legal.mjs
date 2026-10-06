/**
 * Markdown → the legal-page HTML template served at store.busymate.ai/legal/*
 * (nginx `alias /var/www/bmai-legal/<page>.html`). Dependency-free so the host
 * can regenerate the pages from the repo checkout with plain `node`:
 *
 *   node scripts/render-legal.mjs --out /var/www/bmai-legal
 *
 * Supports the subset the docs use: # / ## / ### headings, paragraphs (with
 * soft-wrapped lines joined), - bullets and 1. numbered lists (wrapped
 * continuation lines joined into the item), GFM tables, **bold**, `code`,
 * [links](url), and HTML comments (stripped). Everything else is escaped text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LEGAL_PAGES = [
  { file: "privacy.md", route: "/legal/privacy", out: "privacy.html", title: "Privacy Policy — Busymate AI for Shopify" },
  { file: "faq.md", route: "/legal/faq", out: "faq.html", title: "FAQ — Busymate AI for Shopify" },
  { file: "terms.md", route: "/legal/terms", out: "terms.html", title: "Terms of Service & Data Processing — Busymate AI for Shopify" },
];

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         color:#1a1a1a; background:#fff; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 48px 24px 96px; }
  header.brand { display:flex; align-items:center; gap:12px; margin-bottom:32px; padding-bottom:20px; border-bottom:1px solid #e5e7eb; }
  header.brand .dot { width:36px;height:36px;border-radius:9px;background:#34d399;display:inline-flex;align-items:center;justify-content:center;font-size:20px; }
  header.brand b { font-size:17px; }
  nav.legal a { margin-right: 14px; font-size: 14px; }
  h1 { font-size: 30px; line-height:1.2; margin: 8px 0 6px; }
  h2 { font-size: 21px; margin: 36px 0 10px; padding-top: 8px; }
  h3 { font-size: 17px; margin: 24px 0 8px; }
  p, li { color:#2b2b2b; }
  a { color:#0a7d55; }
  code { background:#f3f4f6; padding:1px 5px; border-radius:4px; font-size:.9em; }
  table { border-collapse: collapse; width:100%; margin:14px 0; font-size:14.5px; display:block; overflow-x:auto; }
  th,td { border:1px solid #e5e7eb; padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#f9fafb; }
  footer { margin-top:56px; padding-top:20px; border-top:1px solid #e5e7eb; color:#6b7280; font-size:13.5px; }
  @media (prefers-color-scheme: dark) {
    body { color:#e6e6e6; background:#0b0f0e; }
    header.brand { border-color:#1f2a27; } header.brand .dot { background:#34d399; }
    p,li { color:#cfd6d3; } a { color:#4ade80; } code { background:#152019; }
    th,td { border-color:#1f2a27; } th { background:#111917; }
    footer { border-color:#1f2a27; color:#8b9691; }
  }
`;

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline markdown → HTML (escape first, then bold / code / links). */
export function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function renderTable(rows) {
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
  const [head, , ...body] = rows;
  const th = cells(head).map((c) => `<th>${c}</th>`).join("");
  const tr = body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** Markdown body → HTML fragment. */
export function markdownToHtml(md) {
  const src = md.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  const isTable = (l) => /^\s*\|.*\|\s*$/.test(l);
  const bullet = (l) => l.match(/^\s*[-*]\s+(.*)$/);
  const numbered = (l) => l.match(/^\s*\d+\.\s+(.*)$/);
  const heading = (l) => l.match(/^(#{1,3})\s+(.*)$/);
  const blank = (l) => !l.trim();

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i += 1; continue; }
    const h = heading(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>`); i += 1; continue; }
    if (isTable(line)) {
      const rows = [];
      while (i < lines.length && isTable(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows));
      continue;
    }
    if (bullet(line) || numbered(line)) {
      const ordered = Boolean(numbered(line));
      const items = [];
      while (i < lines.length && !blank(lines[i])) {
        const m = ordered ? numbered(lines[i]) : bullet(lines[i]);
        if (m) items.push(m[1].trim());
        else if (items.length && /^\s+/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i += 1;
      }
      out.push(`<${ordered ? "ol" : "ul"}>\n${items.map((t) => `<li>${inline(t)}</li>`).join("\n")}\n</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && !blank(lines[i]) && !heading(lines[i]) && !isTable(lines[i]) && !bullet(lines[i]) && !numbered(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

/** Full page: brand shell + nav + body + footer. */
export function renderLegalHtml(md, title) {
  const NAV_LABELS = { "/legal/privacy": "Privacy", "/legal/faq": "FAQ", "/legal/terms": "Terms" };
  const nav = LEGAL_PAGES.map((p) => `<a href="${p.route}">${NAV_LABELS[p.route] ?? p.route}</a>`).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="robots" content="index,follow">
<style>${STYLE}</style>
</head><body><div class="wrap">
<header class="brand"><span class="dot">💬</span><b>Busymate AI for Shopify</b></header>
<nav class="legal">${nav}</nav>
${markdownToHtml(md)}
<footer>© ${new Date().getUTCFullYear()} Busymate AI · <a href="https://busymate.ai">busymate.ai</a> · Support: <a href="mailto:hi@busymate.ai">hi@busymate.ai</a></footer>
</div></body></html>
`;
}

/** Render every legal page from `<repo>/docs/legal`. Returns [{ out, html }]. */
export function renderAllLegal(rootDir) {
  return LEGAL_PAGES.map((p) => ({
    ...p,
    html: renderLegalHtml(readFileSync(join(rootDir, "docs", "legal", p.file), "utf8"), p.title),
  }));
}
