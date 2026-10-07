// Phase E: export formats.
//
// The registry is extensible on purpose: word, excel and zip are the documented
// next step, so a format is a descriptor rather than a branch in the handler.
// The pure renderers are pinned here; PDF shells out to Python and is covered
// by its own test against the real helper.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_FORMATS,
  listFormats,
  getFormat,
  renderText,
  renderMarkdown,
  renderCsv,
  parseTables,
  defaultFormat,
} from "../export.js";

test("the five required formats are registered", () => {
  const ids = listFormats().map((f) => f.id);
  for (const want of ["pdf", "html", "markdown", "text", "csv"]) {
    assert.ok(ids.includes(want), `missing format ${want} (have ${ids.join(", ")})`);
  }
});

test("every format declares an extension, a label and a mime type", () => {
  for (const f of listFormats()) {
    assert.ok(f.extension, `${f.id} needs an extension`);
    assert.match(f.mime, /^[a-z]+\/[a-z0-9.+-]+$/i, `${f.id} needs a mime type`);
    assert.ok(f.label, `${f.id} needs a label`);
    assert.equal(typeof f.render, "function", `${f.id} needs a render function`);
  }
});

test("the registry is extensible: a future format is a descriptor, not a branch", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../export.js", import.meta.url), "utf8")
  );
  // A future word/excel/zip format must be addable by adding an entry. If the
  // handler grew a switch on format id, that promise is broken.
  assert.ok(
    !/if\s*\(\s*(?:format|fmt)\s*===?\s*["']/.test(src),
    "formats must be dispatched via the registry, not an if-chain"
  );
});

test("getFormat returns null for an unknown id rather than throwing", () => {
  assert.equal(getFormat("nope"), null);
  assert.equal(getFormat("pdf").id, "pdf");
});

test("defaultFormat is one a phone can open without an extra app", () => {
  const f = getFormat(defaultFormat());
  assert.ok(f, "the default format must exist");
  assert.ok(["pdf", "html", "text", "markdown"].includes(f.id));
});

test("renderText passes the body through unchanged", () => {
  const body = "line one\nline two\n\nwith a gap";
  assert.equal(renderText(body), body);
  assert.equal(renderText(null), "");
});

test("renderMarkdown adds a title heading and keeps the body verbatim", () => {
  const md = renderMarkdown({ title: "Trip", body: "Lisbon in May." });
  assert.match(md, /^# Trip/);
  assert.ok(md.includes("Lisbon in May."));
});

test("renderMarkdown escapes nothing - it is markdown, not html", () => {
  // A body containing markdown must stay markdown; escaping would corrupt it.
  const md = renderMarkdown({ title: "T", body: "**bold** and `code`" });
  assert.ok(md.includes("**bold** and `code`"));
});

test("parseTables finds a pipe table and its rows", () => {
  const body = [
    "Intro line",
    "| City | Month |",
    "| --- | --- |",
    "| Lisbon | May |",
    "| Porto | June |",
    "After line",
  ].join("\n");
  const tables = parseTables(body);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ["City", "Month"]);
  assert.deepEqual(tables[0].rows, [
    ["Lisbon", "May"],
    ["Porto", "June"],
  ]);
});

test("parseTables ignores a separator-only block and a table with no rows", () => {
  assert.deepEqual(parseTables("| --- | --- |"), []);
  assert.deepEqual(parseTables("no table here"), []);
  assert.deepEqual(parseTables(""), []);
});

test("parseTables finds several tables", () => {
  const body = [
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "text between",
    "",
    "| C | D |",
    "| --- | --- |",
    "| 3 | 4 |",
  ].join("\n");
  const tables = parseTables(body);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[1].headers, ["C", "D"]);
});

test("renderCsv emits a table with a header row", () => {
  const body = ["| City | Month |", "| --- | --- |", "| Lisbon | May |"].join("\n");
  const csv = renderCsv(body);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "City,Month");
  assert.equal(lines[1], "Lisbon,May");
});

test("renderCsv quotes a field containing a comma, quote or newline", () => {
  const body = [
    "| Note | Qty |",
    "| --- | --- |",
    '| "hello, world" | 3 |',
  ].join("\n");
  const csv = renderCsv(body);
  // RFC 4180: embedded quotes are doubled and the field is wrapped.
  assert.ok(csv.includes('"'), "a field with a comma must be quoted");
  assert.ok(csv.includes('""'), "an embedded quote must be doubled");
});

test("renderCsv with no table falls back to one column, so nothing is lost", () => {
  // Exporting prose as CSV must still produce the prose, not an empty file.
  const csv = renderCsv("just a sentence\nand another");
  assert.ok(csv.includes("just a sentence"));
  assert.ok(csv.includes("and another"));
});

test("renderCsv output is parseable back to the same rows", () => {
  const body = ["| A | B |", "| --- | --- |", "| x | y |"].join("\n");
  const csv = renderCsv(body);
  const rows = csv.trim().split("\n").map((l) => l.split(","));
  assert.deepEqual(rows, [["A", "B"], ["x", "y"]]);
});

test("formats that need a subprocess are marked async, pure ones are not", () => {
  assert.equal(getFormat("text").needsProcess, undefined);
  assert.equal(getFormat("csv").needsProcess, undefined);
  assert.equal(getFormat("pdf").needsProcess, true, "pdf shells out to Python");
});
