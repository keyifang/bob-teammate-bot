// Cloudflare R2 project storage.
//
// R2 is used rather than Supabase Storage because it has ZERO EGRESS FEES, and
// the whole point of project storage is that the user downloads their own
// project back. Supabase Storage meters egress, so a user retrieving a small
// coding project repeatedly would pay to get their own files.
//
// The AWS SDK is deliberately NOT a dependency: it is ~10MB for four calls, and
// R2 is S3-compatible, so those calls are made with fetch and SigV4. That keeps
// the image small and adds no deploy-target requirements.
//
// Everything here is inert without credentials. A deployment that has not
// configured R2 simply does not offer project storage - it is not an error.

export const MAX_PROJECT_FILES = Number(process.env.MAX_PROJECT_FILES ?? 200);
export const MAX_PROJECT_BYTES = Number(process.env.MAX_PROJECT_BYTES ?? 5_000_000);

// Every credential is required. A partial config would fail at the first call
// with an opaque 403, which is worse than the feature being off.
export function storageConfigured(env = process.env) {
  if (!env) return false;
  return Boolean(
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
  );
}

/**
 * Normalises a project-relative path, or returns null if it escapes.
 *
 * A stored path can be attacker-influenced (it may have come from a chat
 * message), so a traversal is refused rather than silently rewritten. A benign
 * "a/b/../c" is resolved, because that is a normal thing for a tool to emit.
 */
export function safeProjectPath(input) {
  const raw = String(input ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  if (raw.startsWith("/")) return null;

  const out = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // escapes the project root
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (!out.length) return null;
  return out.join("/");
}

/**
 * The object key for a file. Owner id is the first segment, so one user's
 * prefix cannot collide with another's and a listing is naturally scoped.
 */
export function projectKey(ownerUserId, projectName, filePath) {
  const safe = safeProjectPath(filePath);
  if (!safe) throw new Error(`invalid path: ${JSON.stringify(filePath)} - it escapes the project`);
  const name = safeProjectPath(projectName) ?? "project";
  return `${ownerUserId}/${name}/${safe}`;
}

/**
 * Checks a manifest before anything is uploaded. Refusing early with a readable
 * reason beats failing halfway through and leaving a partial project behind.
 */
export function validateProject(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "There are no files to store." };
  }
  if (files.length > MAX_PROJECT_FILES) {
    return {
      ok: false,
      error: `That is too many files (${files.length}); the limit is ${MAX_PROJECT_FILES}.`,
    };
  }

  let totalBytes = 0;
  for (const f of files) {
    const size = Number(f?.size) || 0;
    if (size > MAX_PROJECT_BYTES) {
      return {
        ok: false,
        error: `"${f?.path ?? "a file"}" is too large; the limit is ${MAX_PROJECT_BYTES} bytes.`,
      };
    }
    totalBytes += size;
  }
  if (totalBytes > MAX_PROJECT_BYTES) {
    return {
      ok: false,
      error: `That project is too big (${totalBytes} bytes); the limit is ${MAX_PROJECT_BYTES}.`,
    };
  }
  return { ok: true, totalBytes, fileCount: files.length };
}

// --- SigV4 + the four calls ------------------------------------------------
//
// Implemented with fetch rather than an SDK. Kept in this module so the
// credential handling is in one place and testable.

import crypto from "node:crypto";

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

export function signingKey(secretAccessKey, dateStamp, region, service) {
  let k = hmac(`AWS4${secretAccessKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  return hmac(k, "aws4_request");
}

/**
 * Builds the SigV4 headers for a request. Exported so the signature can be
 * tested against a known vector rather than only exercised end to end.
 */
export function signRequest({
  method,
  host,
  path,
  query = "",
  body = Buffer.alloc(0),
  region = "auto",
  service = "s3",
  accessKeyId,
  secretAccessKey,
  now = new Date(),
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(secretAccessKey, dateStamp, region, service), stringToSign)
    .toString("hex");

  return {
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}

function r2Config(env = process.env) {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
  };
}

function r2Host(accountId) {
  return `${accountId}.r2.cloudflarestorage.com`;
}

async function r2Request({ method, key, body = Buffer.alloc(0), env = process.env }) {
  if (!storageConfigured(env)) throw new Error("R2 is not configured");
  const cfg = r2Config(env);
  const host = r2Host(cfg.accountId);
  const path = `/${cfg.bucket}/${key}`;
  const headers = signRequest({
    method,
    host,
    path,
    body,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });

  const res = await fetch(`https://${host}${path}`, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 ${method} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}

export async function putProjectFile(ownerUserId, projectName, filePath, contents, env = process.env) {
  const key = projectKey(ownerUserId, projectName, filePath);
  await r2Request({ method: "PUT", key, body: Buffer.from(contents), env });
  return key;
}

export async function getProjectFile(ownerUserId, projectName, filePath, env = process.env) {
  const key = projectKey(ownerUserId, projectName, filePath);
  const res = await r2Request({ method: "GET", key, env });
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteProjectFile(ownerUserId, projectName, filePath, env = process.env) {
  const key = projectKey(ownerUserId, projectName, filePath);
  await r2Request({ method: "DELETE", key, env });
  return key;
}
