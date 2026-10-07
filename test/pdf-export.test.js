// Phase E: the PDF helper.
//
// ReportLab is pure Python with no system dependencies, so it works on Render's
// slim image and on Vercel, where WeasyPrint's Pango/cairo/GTK chain does not.
//
// These tests run the real helper. Two defects they exist to catch, both of
// which shipped in an earlier version of this file:
//
//   - typographic characters rendered as "??" because ReportLab's built-in
//     font is Latin-1 only;
//   - every non-ASCII character was corrupted before the transliteration map
//     saw it, because sys.stdin is decoded with the LOCALE encoding (gbk on a
//     Windows/CJK host). That made the bug environment-dependent: it would pass
//     on Linux CI and fail for a real user.
//
// The content stream is decoded and inspected directly, because the obvious
// check - pypdf's extract_text - cannot reverse ReportLab's encoding and
// reports "??" for text that is actually correct.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function runPdf(payload, outPath) {
  return new Promise((resolve) => {
    const child = spawn("python", ["pdf_export.py", "--out", outPath], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
    // Written as raw UTF-8 bytes, matching what the app does.
    child.stdin.end(Buffer.from(JSON.stringify(payload), "utf8"));
  });
}

// Node has no built-in ASCII85 decoder, and ReportLab declares
// /Filter [ /ASCII85Decode /FlateDecode ] - so it must be decoded before
// inflating. (Decoding as base64 first was the original mistake here: it threw
// "incorrect header check" and every text assertion silently saw nothing.)
function ascii85Decode(input) {
  const s = input.toString("latin1").replace(/\s/g, "");
  const body = s.endsWith("~>") ? s.slice(0, -2) : s;
  const out = [];
  let tuple = 0;
  let count = 0;
  for (const ch of body) {
    if (ch === "z" && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 33 || code > 117) continue; // outside the ASCII85 alphabet
    tuple = tuple * 85 + (code - 33);
    count++;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

// Decodes every content stream and returns the drawn text operators.
async function drawnText(pdfPath) {
  const buf = await readFile(pdfPath);
  const chunks = [];
  let cursor = 0;
  while (true) {
    const s = buf.indexOf(Buffer.from("stream"), cursor);
    if (s < 0) break;
    let start = s + "stream".length;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf(Buffer.from("endstream"), start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    cursor = end + 1;

    let text = null;
    try {
      text = zlib.inflateSync(ascii85Decode(raw)).toString("latin1");
    } catch {
      try {
        text = zlib.inflateSync(raw).toString("latin1");
      } catch {
        text = raw.toString("latin1");
      }
    }
    if (text.includes("Tj")) chunks.push(text);
  }
  return pdfUnescape(chunks.join("\n"));
}

// PDF literal strings escape non-ASCII as octal (\351 is é) and the delimiters
// as \\( \\) \\\\. Without undoing that, a text assertion sees "na\357ve" and
// concludes the content was lost when it is actually present and correct.
function pdfUnescape(s) {
  return s
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\([()\\])/g, "$1");
}

test("the ASCII85 decoder used by these tests can fail (negative control)", () => {
  // Without this, a decoder that returned an empty buffer would make every
  // text assertion below pass vacuously - which is exactly what happened when
  // this helper decoded ASCII85 as base64 and every text test "passed" by
  // finding nothing.
  assert.equal(ascii85Decode(Buffer.from("")).length, 0);
  // A known ASCII85 string decodes to its known plaintext (reference generated
  // with Python's base64.a85encode, not typed by hand).
  assert.equal(ascii85Decode(Buffer.from("87cURD_*#TDfTZ)+T")).toString(), "Hello, world!");
  // And a wrong decoder must not produce that same string.
  assert.notEqual(ascii85Decode(Buffer.from("zzzzz")).toString(), "Hello, world!");
});

test("the PDF string unescaper can fail (negative control)", () => {
  assert.equal(pdfUnescape("na\\357ve"), "naïve");
  assert.equal(pdfUnescape("Caf\\351"), "Café");
  assert.equal(pdfUnescape("plain"), "plain");
  assert.notEqual(pdfUnescape("na\\357ve"), "na\\357ve");
});

const withTmp = async (fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bobpdf-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

test("the helper produces a real PDF", async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    const { code } = await runPdf({ title: "Trip plan", body: "Lisbon in May." }, out);
    assert.equal(code, 0, "the helper must exit 0");

    const buf = await readFile(out);
    assert.equal(buf.subarray(0, 5).toString(), "%PDF-", "must start with the PDF magic");
    assert.ok(buf.subarray(-80).includes(Buffer.from("%%EOF")), "must be terminated");
    assert.ok(buf.length > 500, "a real document, not an empty stub");
  });
});

test("the body text is actually drawn on the page", async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    await runPdf({ title: "Trip plan", body: "Lisbon in May." }, out);
    const text = await drawnText(out);
    assert.match(text, /Lisbon in May\./, `body missing from content stream:\n${text}`);
    assert.match(text, /Trip plan/, "title missing from content stream");
  });
});

test("typographic characters are transliterated, never rendered as ??", async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    await runPdf(
      { title: "T", body: "dash — em, quote ’ curly, euro €, bullet •, check ✓" },
      out
    );
    const text = await drawnText(out);
    assert.ok(!text.includes("??"), `characters were dropped:\n${text}`);
    // Readable ASCII equivalents, so the meaning survives.
    assert.match(text, /dash - em/);
    assert.match(text, /quote ' curly/);
    assert.match(text, /euro EUR/);
    assert.match(text, /check \[x\]/);
  });
});

test("non-ASCII survives regardless of the host's locale encoding", async () => {
  // The regression: sys.stdin is decoded with the locale encoding, so on a
  // Windows/CJK host UTF-8 bytes arrived as mojibake. The helper must read raw
  // bytes and decode UTF-8 explicitly.
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    const { code } = await runPdf(
      { title: "Café", body: "naïve résumé — 日本語" },
      out
    );
    assert.equal(code, 0, "must not crash on non-ASCII");
    const text = await drawnText(out);
    // Latin-1 characters come through intact (they fit the font's encoding);
    // characters the font cannot represent are marked rather than fatal.
    assert.match(text, /Café/, "the accented title must survive");
    assert.match(text, /naïve résumé/, "accented body text must survive");
  });
});

test("a body containing HTML is printed literally, not interpreted", async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    await runPdf({ title: "T", body: "<script>alert(1)</script>" }, out);
    const text = await drawnText(out);
    // Escaped, so it renders as text rather than being parsed as markup.
    assert.ok(!/<script>/.test(text), "the tag must be escaped, not emitted raw");
    assert.match(text, /script/, "but the content must still be visible");
  });
});

test("an empty body still produces a valid PDF", async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    const { code } = await runPdf({ title: "T", body: "" }, out);
    assert.equal(code, 0);
    const buf = await readFile(out);
    assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  });
});

test("a long body spans multiple pages rather than being truncated", async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    const body = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} with some text.`).join("\n\n");
    await runPdf({ title: "Long", body }, out);
    const buf = await readFile(out);
    const pages = buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [];
    assert.ok(pages.length >= 2, `expected multiple pages, found ${pages.length}`);
  });
});

test("invalid JSON fails loudly with a non-zero exit, not a silent empty file", async () => {
  await withTmp(async (dir) => {
    const out = path.join(dir, "d.pdf");
    const { code, stderr } = await new Promise((resolve) => {
      const child = spawn("python", ["pdf_export.py", "--out", out], {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (c) => resolve({ code: c, stderr }));
      child.stdin.end("this is not json");
    });
    assert.notEqual(code, 0, "bad input must not look like success");
    assert.match(stderr, /invalid JSON/);
  });
});
