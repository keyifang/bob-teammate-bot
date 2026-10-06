// Phase 7: HTML document export.

import test from "node:test";
import assert from "node:assert/strict";

import {
  renderDocumentHtml,
  escapeDocHtml,
  safeFileName,
  MAX_TITLE,
} from "../document.js";

// Negative control: the escaping this suite depends on must be able to fail.
test("escapeDocHtml escapes the characters that would break out of the page (negative control)", () => {
  assert.equal(escapeDocHtml("<b>"), "&lt;b&gt;");
  assert.equal(escapeDocHtml('a"b'), "a&quot;b");
  assert.equal(escapeDocHtml("a&b"), "a&amp;b");
  assert.notEqual(escapeDocHtml("<script>"), "<script>");
});

test("a complete, well-formed document is produced", () => {
  const html = renderDocumentHtml({ title: "Trip plan", body: "Lisbon in May." });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /Lisbon in May\./);
});

test("a title containing markup cannot inject a tag", () => {
  const html = renderDocumentHtml({
    title: '</title><script>alert(1)</script>',
    body: "hi",
  });
  assert.ok(!html.includes("<script>"), "an injected script tag must be escaped");
  assert.match(html, /&lt;script&gt;/);
});

test("a body containing markup cannot inject a tag", () => {
  const html = renderDocumentHtml({
    title: "ok",
    body: '</pre><script>alert(1)</script><pre>',
  });
  assert.ok(!html.includes("<script>"), "a body must never be interpreted as HTML");
  assert.match(html, /&lt;script&gt;/);
});

test("a body containing </html> cannot truncate the document", () => {
  const html = renderDocumentHtml({ title: "x", body: "</html>tail" });
  assert.ok(html.endsWith("</html>\n"), "the real document must still close last");
  assert.equal((html.match(/<\/html>/g) ?? []).length, 1);
});

test("the title is length-capped so a huge reply cannot make a huge <title>", () => {
  const html = renderDocumentHtml({ title: "x".repeat(5000), body: "b" });
  const titleTag = html.match(/<title>(.*?)<\/title>/s)[1];
  assert.ok(titleTag.length <= MAX_TITLE, `title tag was ${titleTag.length} chars`);
});

test("source and timestamp appear when given, and are omitted when not", () => {
  const withSource = renderDocumentHtml({
    title: "t",
    body: "b",
    source: "Melbourne Trip",
    createdAt: "2026-10-07T00:00:00.000Z",
  });
  assert.match(withSource, /Melbourne Trip/);
  assert.match(withSource, /2026-10-07/);

  const without = renderDocumentHtml({ title: "t", body: "b" });
  assert.ok(!without.includes("undefined"));
});

test("an empty body still produces a valid document rather than throwing", () => {
  const html = renderDocumentHtml({ title: "t", body: "" });
  assert.match(html, /<pre><\/pre>/);
});

test("a non-ASCII body survives intact", () => {
  const body = "予約は木曜でいい？ 🎉";
  const html = renderDocumentHtml({ title: "t", body });
  assert.ok(html.includes(body), "unicode must not be mangled");
});

test("safeFileName produces a usable name with an extension", () => {
  assert.equal(safeFileName("Trip plan"), "Trip-plan.html");
  assert.equal(safeFileName("a/b\\c:d"), "abcd.html");
  assert.equal(safeFileName("   "), "bob-document.html");
  assert.equal(safeFileName(""), "bob-document.html");
  assert.equal(safeFileName("plan", "pdf"), "plan.pdf");
});

test("safeFileName caps length so Telegram accepts the upload", () => {
  const name = safeFileName("x".repeat(500));
  assert.ok(name.length <= 65, `name was ${name.length} chars`);
  assert.match(name, /\.html$/);
});

test("safeFileName never produces a path separator or a leading dot", () => {
  for (const raw of ["../etc/passwd", ".hidden", "a/../../b"]) {
    const name = safeFileName(raw);
    assert.ok(!name.includes("/") && !name.includes("\\"), `separator in ${name}`);
    assert.ok(!name.startsWith("."), `leading dot in ${name}`);
  }
});
