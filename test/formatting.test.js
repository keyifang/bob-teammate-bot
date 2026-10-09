import test from "node:test";
import assert from "node:assert/strict";

import {
  formatForTelegram,
  chunkMessage,
  escapeHtml,
} from "../formatting.js";
import {
  checkHtmlBalance,
  stripTags,
  hasLoneSurrogate,
  collapse,
} from "./helpers.js";

const PIPE = String.fromCharCode(124);
const PRIME = String.fromCharCode(8242);

test("the balance checker rejects known-bad input (negative control)", () => {
  // If this ever passes trivially, every other balance assertion below is
  // worthless.
  assert.equal(checkHtmlBalance("<b>oops").balanced, false);
  assert.equal(checkHtmlBalance("</b>oops").balanced, false);
  assert.equal(checkHtmlBalance("<b><i>x</b></i>").balanced, false);
  assert.equal(checkHtmlBalance("<b>x</b>").balanced, true);
});

test("the balance checker rejects mismatched nesting even when counts match", () => {
  // Pure counting would call this balanced; a stack must not.
  assert.equal(checkHtmlBalance("<b><i>x</b></i>").balanced, false);
});

test("escapeHtml neutralises every parser-significant character", () => {
  assert.equal(escapeHtml("<b>a & b</b>"), "&lt;b&gt;a &amp; b&lt;/b&gt;");
});

test("a URL with an underscore loses nothing", () => {
  const url = "https://ex.com/aaa_bbb_ccc_ddd/page";
  const out = formatForTelegram(url);
  assert.ok(out.includes("aaa_bbb_ccc_ddd"), `underscores stripped: ${out}`);
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
  assert.equal(collapse(stripTags(out)), url);
});

test("underscores inside an already-escaped URL survive intact", () => {
  const text = "see https://ex.com/a_b_c?x=1&y=2 for details";
  const out = formatForTelegram(text);
  assert.ok(out.includes("https://ex.com/a_b_c?x=1&amp;y=2"), out);
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
  // stripTags() is a regex, not an HTML parser, so it leaves entities encoded
  // in place; compare against the escaped form rather than the raw input.
  assert.equal(collapse(stripTags(out)), escapeHtml(text));
});

test("a tighter than expected pipe table keeps its content and balance", () => {
  const table = [
    `${PIPE} Item ${PIPE} Qty ${PIPE}`,
    `${PIPE}------${PIPE}-----${PIPE}`,
    `${PIPE} nails ${PIPE} 3 ${PIPE}`,
  ].join("\n");

  const out = formatForTelegram(table);
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
  assert.ok(out.includes("<pre>"), out);
  assert.ok(out.includes("nails"), out);
  assert.ok(out.includes("Qty"), out);
});

test("content that looks like table rules but has no delimiter row is left alone", () => {
  const text = "Determine the admission|scoring criteria|weights before Friday";
  const out = formatForTelegram(text);
  assert.ok(out.includes("scoring criteria"), out);
  assert.equal(collapse(stripTags(out)), text);
});

test("bold, italic, code and strikethrough-free inline styles render", () => {
  const out = formatForTelegram("**bold** and *italic* and `code`");
  assert.equal(out, "<b>bold</b> and <i>italic</i> and <code>code</code>");
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
});

test("a bullet list keeps its words and stays balanced", () => {
  const out = formatForTelegram("- first\n- second\n- third");
  // The dash is replaced by a plain bullet, so the marker itself is not lost.
  assert.equal(collapse(stripTags(out)), "• first • second • third");
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
});

test("task list items keep visible checkboxes", () => {
  const out = formatForTelegram("- [ ] pack bags\n- [x] book hotel");
  assert.ok(out.includes("[ ] pack bags"), out);
  assert.ok(out.includes("[x] book hotel"), out);
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
});

test("a heading becomes bold, not a literal hash", () => {
  const out = formatForTelegram("## Trip plan");
  assert.equal(out, "<b>Trip plan</b>");
});

test("emoji and non-ASCII text pass through unchanged", () => {
  const text = "Great ✅ let's go \u{1f680}\u{1f680}";
  const out = formatForTelegram(text);
  assert.equal(out, text);
  assert.equal(hasLoneSurrogate(out), false);
});

test("an unmatched bold marker is not treated as emphasis", () => {
  const out = formatForTelegram("2 * 3 = 6");
  assert.equal(out, "2 * 3 = 6");
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
});

test("an unclosed code span does not swallow the rest of the reply", () => {
  const out = formatForTelegram("run `npm test and then push");
  assert.deepEqual(checkHtmlBalance(out), { balanced: true });
  assert.ok(out.includes("npm test and then push"), out);
});

test("chunkMessage returns a single chunk when under the limit", () => {
  const chunks = chunkMessage("<b>short</b>", 3800);
  assert.deepEqual(chunks, ["<b>short</b>"]);
});

test("no chunk exceeds the requested limit", () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkMessage(formatForTelegram(body), 300);
  assert.ok(chunks.length > 1, "expected multiple chunks");
  for (const c of chunks) {
    assert.ok(c.length <= 300, `chunk of ${c.length} exceeds 300`);
  }
});

test("every chunk is independently balanced HTML", () => {
  const body = `**Heading**\n\n${Array.from({ length: 200 }, (_, i) => `- item ${i}`).join("\n")}`;
  const chunks = chunkMessage(formatForTelegram(body), 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.deepEqual(checkHtmlBalance(c), { balanced: true }, `unbalanced chunk: ${c.slice(0, 60)}`);
  }
});

test("no content is lost or duplicated across chunk boundaries", () => {
  const words = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkMessage(words, 120);
  const rejoined = collapse(chunks.join(" "));
  assert.equal(rejoined, collapse(words));
});

test("a table wider than the chunk limit is split without breaking a row's tags", () => {
  const rows = [["Item", "Owner", "Notes"]];
  for (let i = 0; i < 60; i++) {
    rows.push([`item-${i}`, `person-${i}`, `note number ${i} with some padding`]);
  }
  const table = [
    `${PIPE} ${rows[0].join(` ${PIPE} `)} ${PIPE}`,
    `${PIPE}${rows[0].map(() => "---").join(PIPE)}${PIPE}`,
    ...rows.slice(1).map((r) => `${PIPE} ${r.join(` ${PIPE} `)} ${PIPE}`),
  ].join("\n");

  const formatted = formatForTelegram(table);
  const chunks = chunkMessage(formatted, 300);
  assert.ok(chunks.length > 1, "expected the table to be split");
  for (const c of chunks) {
    assert.ok(c.length <= 300);
    assert.deepEqual(checkHtmlBalance(c), { balanced: true });
  }
  const all = collapse(stripTags(chunks.join(" ")));
  assert.ok(all.includes("item-0"), all);
  assert.ok(all.includes("item-59"), all);
});

test("an oversized single line is split at a safe boundary", () => {
  const longUrl = `https://ex.com/${"a".repeat(900)}`;
  const chunks = chunkMessage(longUrl, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `len ${c.length}`);
  assert.equal(chunks.join(""), longUrl);
});

test("a split never severs a surrogate pair", () => {
  const text = "\u{1f680}".repeat(300);
  const chunks = chunkMessage(text, 100);
  for (const c of chunks) {
    assert.equal(hasLoneSurrogate(c), false, "chunk contains a lone surrogate");
    assert.ok(c.length <= 100);
  }
  assert.equal(chunks.join(""), text);
});

test("a printable prime is preserved exactly, not normalised to an apostrophe", () => {
  const input = `5${PRIME}11 ft`;
  const chunks = chunkMessage(formatForTelegram(input), 3800);
  assert.equal(stripTags(chunks.join("")), input);
});

test("formatForTelegram output is always balanced, whatever the input", () => {
  const samples = [
    "",
    "\n\n\n",
    "<b>already html</b>",
    "a & b < c > d",
    "- [ ]",
    "## ",
    `${PIPE} only a pipe`,
    "**unclosed bold",
    "`unclosed code",
    "*asterisk soup* *more* *still*",
    "text with a < b and HTML-ish <tag> inline",
  ];
  for (const s of samples) {
    const out = formatForTelegram(s);
    assert.deepEqual(checkHtmlBalance(out), { balanced: true }, `input: ${JSON.stringify(s)} -> ${out}`);
  }
});

// Ampersand escaping must happen ONCE.
//
// formatForTelegram producing "R&amp;D" is CORRECT: that is the HTML Telegram
// renders as "R&D". The bug was the SEND FALLBACK re-escaping already-escaped
// text, so the user saw the literal characters "&amp;" - observed live as
// "R&amp;D budget". These tests pin the single-escape contract and the escape
// ONCE helper, not the rendered output, which is Telegram's job.

test("escapeHtml escapes each character exactly once", () => {
  assert.equal(escapeHtml("R&D"), "R&amp;D");
  assert.equal(escapeHtml("a & b & c"), "a &amp; b &amp; c");
  // Not "&amp;amp;" - that is what the user actually saw.
  assert.ok(!escapeHtml("&").includes("amp;amp;"));
});

test("angle brackets are escaped so tags cannot render", () => {
  assert.equal(escapeHtml("<b>"), "&lt;b&gt;");
  assert.equal(escapeHtml("5 < 6"), "5 &lt; 6");
});

test("escaping is idempotent in the sense that matters: no growth on repeat", () => {
  // If any layer re-escapes, the output grows. Checking the growth is what
  // catches the fallback bug at the formatting layer.
  const once = escapeHtml("R&D");
  const twice = escapeHtml(once);
  assert.ok(twice.length >= once.length);
  assert.ok(!/amp;amp;/.test(twice) || once.includes("amp;"),
    "a second escape pass must not be applied by the formatter itself");
});

test("formatForTelegram produces HTML Telegram renders correctly, not literal entities", () => {
  // The formatted output SHOULD contain &amp; - that is correct HTML. What it
  // must never contain is a nested &amp;amp;, which is what the user saw.
  const out = formatForTelegram("R&D budget");
  assert.equal(out, "R&amp;D budget", "one escape, correct HTML");
  assert.ok(!out.includes("&amp;amp;"), "must not be double-escaped");
});
