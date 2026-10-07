// Runs pdf_export.py and returns the PDF bytes.
//
// ReportLab is used rather than WeasyPrint because it is pure Python with no
// system dependencies, so this works on Render's slim image AND on Vercel,
// where WeasyPrint's Pango/cairo/GTK chain does not.
//
// stdin carries the payload as raw UTF-8 BYTES, not a string. Node's default
// string write would encode with the platform's encoding on the Python side,
// which corrupted every non-ASCII character on a Windows/CJK host - a bug that
// passed on Linux and failed for a real user.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "pdf_export.py");
const TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS ?? 30000);

// Prefer the same interpreter name the search helper uses, so one deployment
// detail (python vs python3) is configured in one place.
const PYTHON = process.env.PYTHON_BIN ?? "python";

// ReportLab needs a path, not a stream, so the helper writes to a temp file and
// this reads it back. The directory is per-call and removed afterwards, so two
// concurrent exports cannot collide or leave debris behind.
export async function renderPdfBuffer({ title, body, source, createdAt }) {
  const dir = await mkdtemp(path.join(tmpdir(), "bobpdf-"));
  const outPath = path.join(dir, "out.pdf");
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(PYTHON, [SCRIPT, "--out", outPath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        return reject(new Error(`could not start ${PYTHON}: ${err.message}`));
      }

      let err = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`pdf_export.py timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);

      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`could not run ${PYTHON}: ${e.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(err.trim() || `pdf_export.py exited ${code}`));
        else resolve();
      });

      child.stdin.on("error", () => {}); // the child may exit before we finish writing
      // Raw UTF-8 bytes: a string write would be encoded with the platform's
      // encoding on the Python side, corrupting non-ASCII on a Windows/CJK host.
      child.stdin.end(Buffer.from(JSON.stringify({ title, body, source, createdAt }), "utf8"));
    });

    const buf = await readFile(outPath);
    if (buf.length < 5 || buf.subarray(0, 5).toString() !== "%PDF-") {
      // A file that is not a PDF must never be sent to a user as one.
      throw new Error("pdf_export.py did not produce a PDF");
    }
    return buf;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
