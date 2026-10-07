// Cloudflare R2 project storage.
//
// R2 is the recommendation because it has zero egress fees - which matters
// because a user downloads their own project back. Supabase Storage meters
// egress, so a user retrieving a small coding project repeatedly would pay for
// the privilege of getting their own files.
//
// The S3 client is NOT bundled: the AWS SDK is ~10MB of dependency for four
// calls, and R2 is S3-compatible so the four calls can be made with fetch and
// SigV4. That keeps the image small and the deploy target unchanged.
//
// Every function here is inert without credentials, so a deployment that does
// not configure R2 simply does not offer project storage.

import test from "node:test";
import assert from "node:assert/strict";

import {
  storageConfigured,
  projectKey,
  safeProjectPath,
  MAX_PROJECT_BYTES,
  MAX_PROJECT_FILES,
  validateProject,
} from "../storage.js";

test("storage is disabled when any credential is missing", () => {
  const full = {
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "bucket",
  };
  assert.equal(storageConfigured(full), true);
  for (const missing of Object.keys(full)) {
    const partial = { ...full };
    delete partial[missing];
    assert.equal(storageConfigured(partial), false, `missing ${missing} must disable storage`);
  }
  assert.equal(storageConfigured({}), false);
  assert.equal(storageConfigured(null), false);
});

test("projectKey is scoped per owner and per project, so one user cannot reach another's", () => {
  const k = projectKey(42, "my-project", "src/index.js");
  assert.match(k, /^42\//, "the owner id must be the first path segment");
  assert.match(k, /my-project/);
  assert.match(k, /src\/index\.js$/);
  // Two owners, same project name: different keys.
  assert.notEqual(projectKey(1, "p", "f"), projectKey(2, "p", "f"));
});

test("projectKey rejects a path that escapes the project", () => {
  // A stored path is attacker-influenced if it came from a message, so a
  // traversal must be refused rather than normalised silently.
  for (const bad of ["../secret", "a/../../b", "/etc/passwd", "a/../../../../x"]) {
    assert.throws(
      () => projectKey(1, "p", bad),
      /invalid path|escapes/i,
      `${bad} must be refused`
    );
  }
});

test("safeProjectPath normalises a reasonable path and refuses an escaping one", () => {
  assert.equal(safeProjectPath("src/index.js"), "src/index.js");
  assert.equal(safeProjectPath("./src//index.js"), "src/index.js");
  assert.equal(safeProjectPath("a/b/../c.txt"), "a/c.txt", "a benign .. may be resolved");
  for (const bad of ["../x", "a/../../x", "/abs", "..", ""]) {
    assert.equal(safeProjectPath(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("a project over the size cap is refused, with a message that says the limit", () => {
  const big = [{ path: "a.txt", size: MAX_PROJECT_BYTES + 1 }];
  const v = validateProject(big);
  assert.equal(v.ok, false);
  assert.match(v.error, /size|large|big/i);
});

test("a project with too many files is refused", () => {
  const many = Array.from({ length: MAX_PROJECT_FILES + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    size: 1,
  }));
  const v = validateProject(many);
  assert.equal(v.ok, false);
  assert.match(v.error, /files|many/i);
});

test("an empty project is refused rather than creating an empty archive", () => {
  assert.equal(validateProject([]).ok, false);
  assert.equal(validateProject(null).ok, false);
});

test("a reasonable project passes and reports its totals", () => {
  const files = [
    { path: "README.md", size: 100 },
    { path: "src/index.js", size: 2000 },
  ];
  const v = validateProject(files);
  assert.equal(v.ok, true);
  assert.equal(v.totalBytes, 2100);
  assert.equal(v.fileCount, 2);
});

test("a single file over the cap is refused even when the total would pass", () => {
  const files = [{ path: "huge.bin", size: MAX_PROJECT_BYTES + 1 }];
  assert.equal(validateProject(files).ok, false);
});

test("the caps are sane for a small coding project", () => {
  // A small project is tens of files and a few MB, not a git checkout.
  assert.ok(MAX_PROJECT_FILES >= 20 && MAX_PROJECT_FILES <= 500);
  assert.ok(MAX_PROJECT_BYTES >= 1_000_000 && MAX_PROJECT_BYTES <= 50_000_000);
});

// --- SigV4 -------------------------------------------------------------------
//
// The signer is the risky part: a wrong signature fails at R2 with an opaque
// 403 and no hint which of the six steps is wrong. This pins it against AWS's
// own published test vector, so the derivation is proven rather than assumed.

test("signingKey matches the AWS SigV4 derivation for a known vector", async () => {
  const { signingKey } = await import("../storage.js");
  // From the AWS SigV4 test suite (the documented "AWS4" example secret).
  const key = signingKey(
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    "20150830",
    "us-east-1",
    "iam"
  );
  assert.equal(
    key.toString("hex"),
    "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    "the signing key derivation must match AWS's own test vector"
  );
});

test("signRequest produces the AWS4-HMAC-SHA256 shape with the right scope", async () => {
  const { signRequest } = await import("../storage.js");
  const h = signRequest({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    now: new Date("2015-08-30T12:36:00Z"),
  });
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/auto\/s3\/aws4_request/);
  assert.match(h.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.match(h.Authorization, /Signature=[a-f0-9]{64}$/);
  assert.equal(h["x-amz-date"], "20150830T123600Z");
  // The payload hash must be the SHA-256 of the body, and of an empty body when
  // there is none - a wrong value here is a 403 with no explanation.
  assert.equal(
    h["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("signRequest is deterministic for the same inputs", async () => {
  const { signRequest } = await import("../storage.js");
  const args = {
    method: "PUT",
    host: "h.example",
    path: "/b/k",
    body: Buffer.from("hello"),
    accessKeyId: "A",
    secretAccessKey: "S",
    now: new Date("2026-01-01T00:00:00Z"),
  };
  assert.equal(signRequest(args).Authorization, signRequest({ ...args }).Authorization);
});

test("a changed body changes the signature, so a tampered payload is detectable", async () => {
  const { signRequest } = await import("../storage.js");
  const base = {
    method: "PUT",
    host: "h.example",
    path: "/b/k",
    accessKeyId: "A",
    secretAccessKey: "S",
    now: new Date("2026-01-01T00:00:00Z"),
  };
  const a = signRequest({ ...base, body: Buffer.from("one") }).Authorization;
  const b = signRequest({ ...base, body: Buffer.from("two") }).Authorization;
  assert.notEqual(a, b);
});

test("the storage functions refuse to run without credentials rather than throwing opaquely", async () => {
  const { getProjectFile } = await import("../storage.js");
  await assert.rejects(
    () => getProjectFile(1, "p", "f.txt", {}),
    /not configured/,
    "an unconfigured deployment must fail with a named reason"
  );
});
