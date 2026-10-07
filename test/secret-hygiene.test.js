// The repository must never contain a credential.
//
// This is not a style rule. Deployment keys for this project were pasted into
// chat transcripts more than once, and a chat transcript is the worst possible
// home for a secret: it is copied between windows, pasted into tools, and kept
// in session history long after it stops being useful. The habit gets a gate
// rather than a reminder.
//
// The gate lives in the test suite so it runs on every `npm test`, not when
// someone remembers to look.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = "D:/My Vibe Coding Projects/scripts/secret-hygiene.mjs";

test("no credential is committed to this repository", { skip: !existsSync(SCANNER) }, () => {
  let output = "";
  let failed = false;
  try {
    output = execFileSync("node", [SCANNER, `--paths=${ROOT}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Non-zero exit means the scanner FOUND something, which is the case this
    // test exists to catch.
    failed = true;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.equal(
    failed,
    false,
    `a credential was found in the repository:\n${output}\n\n` +
      `Rotation is the only fix for an exposed key - this test cannot unsend one.`
  );
});

test("the shared secret vault exists and is outside every repository", { skip: !existsSync(SCANNER) }, () => {
  // The vault is the intended home for deployment keys, and it must not be
  // inside a git repo or `git add` would sweep it in.
  const vault = "D:/My Vibe Coding Projects/scripts/.env.local";
  assert.ok(existsSync(vault), "the vault must exist; keys are not pasted into chat");

  // Same directory as the loader, which is not inside a repository.
  const scriptsDir = path.dirname(vault);
  let insideRepo = true;
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: scriptsDir,
      stdio: "ignore",
    });
  } catch {
    insideRepo = false;
  }
  assert.equal(
    insideRepo,
    false,
    "the vault directory must not be a git repository, or the keys can be committed"
  );
});

test("this repo's .env is gitignored, so a local key cannot be committed", () => {
  assert.ok(existsSync(path.join(ROOT, ".env")), "a local .env is expected to exist");
  let tracked = true;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: ROOT, stdio: "ignore" });
  } catch {
    tracked = false;
  }
  assert.equal(tracked, false, ".env must not be tracked by git");
});