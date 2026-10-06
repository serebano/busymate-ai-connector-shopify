import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderLegalHtml, LEGAL_PAGES } from "../scripts/lib/render-legal.mjs";

/**
 * Legal pages (App Store 4.x support/privacy + the PCD "DPA with merchants"
 * answer). Every published contact must be the OFFICIAL, role-based support
 * mailbox on the product's own domain — never a person's personal mailbox.
 *
 * This test used to pin the owner's personal Gmail and BAN every @busymate.ai
 * address, because busymate.ai had no MX record at the time. It has one now
 * (`mail.busymate.ai`, with SPF), and `hi@busymate.ai` is the platform's
 * ledgered contact channel (busymate.ai/.well-known/security.txt names it), so
 * the guard is inverted: the personal address is what must never be published.
 * A merchant Terms/DPA page must exist and be linked from the privacy policy.
 */
const ROOT = process.cwd();
const SUPPORT_EMAIL = "hi@busymate.ai";
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("legal docs contact + coverage", () => {
  const privacy = read("docs/legal/privacy.md");
  const faq = read("docs/legal/faq.md");
  const terms = read("docs/legal/terms.md");

  it("no personal mailbox is published anywhere", () => {
    for (const [name, text] of [["privacy", privacy], ["faq", faq], ["terms", terms]]) {
      expect(text, name).not.toMatch(/[a-z0-9._-]+@(gmail|googlemail|outlook|hotmail|yahoo|icloud|proton(mail)?)\.[a-z.]+/i);
    }
  });

  it("the privacy policy + FAQ + terms name the listing support email", () => {
    expect(privacy).toContain(SUPPORT_EMAIL);
    expect(faq).toContain(SUPPORT_EMAIL);
    expect(terms).toContain(SUPPORT_EMAIL);
  });

  it("the privacy policy links the merchant Terms/DPA page", () => {
    expect(privacy).toMatch(/https:\/\/store\.busymate\.ai\/legal\/terms/);
  });

  it("the FAQ links the live privacy URL (store.busymate.ai, the listing value)", () => {
    expect(faq).toContain("https://store.busymate.ai/legal/privacy");
    expect(faq).not.toContain("https://busymate.ai/legal/privacy");
  });

  it("the FAQ billing answer states the real plan model (allowance + overage + cap), not pay-per-resolution only", () => {
    expect(faq).toMatch(/Free/);
    expect(faq).toMatch(/\$19/);
    expect(faq).toMatch(/included/i);
    expect(faq).not.toMatch(/pay per \*\*resolved\*\* conversation/i);
  });

  it("the Terms/DPA page covers the processor duties the PCD questionnaire claims", () => {
    for (const heading of ["Data Processing", "Sub-processors", "Security", "Data subject", "Deletion", "Governing law"]) {
      expect(terms, `terms.md mentions ${heading}`).toMatch(new RegExp(heading, "i"));
    }
  });

  it("public naming: no internal codename in any legal page", () => {
    for (const text of [privacy, faq, terms]) expect(text).not.toMatch(/\b(eve|bmai)\b/i);
  });
});

describe("render-legal (markdown → the host HTML template)", () => {
  it("renders the three pages with the brand shell, headings, wrapped list items and tables", () => {
    expect(LEGAL_PAGES.map((p) => p.route)).toEqual(["/legal/privacy", "/legal/faq", "/legal/terms"]);
    const html = renderLegalHtml("# Title\n\nPara one\nwrapped.\n\n- item one\n  continues here\n- item two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n## Section\n\n**bold** and `code` and [link](https://x.example).", "Title — Busymate AI for Shopify");
    expect(html).toContain("<title>Title — Busymate AI for Shopify</title>");
    expect(html).toContain('<header class="brand">');
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Para one wrapped.</p>");
    expect(html).toContain("<li>item one continues here</li>");
    expect(html).toContain("<li>item two</li>");
    expect(html).toContain("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
    expect(html).toContain("<h2>Section</h2>");
    expect(html).toContain('<strong>bold</strong> and <code>code</code> and <a href="https://x.example">link</a>');
  });

  it("strips the HTML comment preamble and escapes raw angle brackets", () => {
    const html = renderLegalHtml("<!-- draft note -->\n# T\n\n1 < 2 & 3 > 2", "T");
    expect(html).not.toContain("draft note");
    expect(html).toContain("<p>1 &lt; 2 &amp; 3 &gt; 2</p>");
  });
});
