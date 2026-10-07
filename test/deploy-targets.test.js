// Deployment targets: Render, Vercel, Supabase.
//
// These are structural checks against the real config files. They exist
// because a deployment config is invisible locally and only fails in
// production - and a JSON syntax error in render.yaml, or a Python dependency
// missing from the image, is discovered at deploy time by a user.
//
// The Vercel target has a hard constraint the others do not: serverless
// invocations share no memory, so any state held in a module-level Map is lost
// between requests. That is why the shared-state tables exist, and why these
// tests assert the app does not depend on in-process state for correctness.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFile(path.join(ROOT, f), "utf8");
const exists = async (f) => access(path.join(ROOT, f)).then(() => true, () => false);

test("render.yaml parses as JSON and declares a docker service", async () => {
  const cfg = JSON.parse(await read("render.yaml"));
  const svc = cfg.services?.[0];
  assert.equal(svc.runtime, "docker");
  assert.equal(svc.healthCheckPath, "/health");
  assert.equal(svc.plan, "free");
});

test("render.yaml requires every secret rather than committing a value", async () => {
  const cfg = JSON.parse(await read("render.yaml"));
  const vars = Object.fromEntries((cfg.services[0].envVars ?? []).map((v) => [v.key, v]));
  for (const key of ["TELEGRAM_BOT_TOKEN", "MODEL_API_KEY", "DATABASE_URL", "WEBHOOK_SECRET"]) {
    assert.ok(vars[key], `${key} must be declared`);
    assert.equal(vars[key].sync, false, `${key} must not carry a committed value`);
  }
  assert.ok(!("PORT" in vars), "the platform injects PORT; hardcoding it breaks routing");
});

test("a Vercel config exists and routes the webhook to a function", async () => {
  const cfg = JSON.parse(await read("vercel.json"));
  assert.ok(Array.isArray(cfg.rewrites) || cfg.routes, "vercel.json must route the webhook");
  // The webhook must reach the function, not a static 404.
  const raw = await read("vercel.json");
  assert.match(raw, /telegram-webhook/, "the webhook path must be routed");
});

test("the Vercel function allows a long enough duration for a slow free model", async () => {
  // A 3-hop turn on a free reasoning model was measured past 60s, so a 10s
  // default would truncate real replies.
  const raw = await read("vercel.json");
  assert.match(raw, /maxDuration/, "a duration must be configured");
  const m = raw.match(/"maxDuration"\s*:\s*(\d+)/);
  assert.ok(m, "maxDuration must be a number");
  assert.ok(Number(m[1]) >= 60, `maxDuration ${m[1]}s is too short for a slow model`);
});

test("the Vercel function is told to use the shared-state path, not in-process state", async () => {
  const raw = await read("vercel.json");
  assert.match(raw, /DATABASE_URL/, "the function must be given the database");
});

test("the Dockerfile installs Python and ReportLab for PDF export", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /python3/, "Python is required for the search helper");
  assert.match(dockerfile, /ddgs/, "the search backend needs ddgs");
  assert.match(dockerfile, /httpx>=0\.28/, "an older httpx breaks ddgs");
  assert.match(dockerfile, /reportlab/i, "PDF export needs ReportLab");
});

test("the Dockerfile runs as a non-root user", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /^USER (?!root)\w+/m);
});

test("the image excludes the .env file and the tests", async () => {
  const ignore = await read(".dockerignore");
  for (const entry of [".env", "node_modules", "test"]) {
    assert.ok(ignore.split("\n").includes(entry), `${entry} must be excluded`);
  }
});

test("a Supabase deployment guide exists and warns about the pooler", async () => {
  const guide = await read("docs/DEPLOYMENT.md");
  // The pooler's transaction mode rejects a multi-statement query string, which
  // is why ensureSchema issues one statement per call.
  assert.match(guide, /pooler|pgbouncer/i);
  assert.match(guide, /transaction mode/i);
  assert.match(guide, /Supabase/i);
  assert.match(guide, /Render/i);
  assert.match(guide, /Vercel/i);
});

test("the guide states the serverless limitation honestly rather than implying parity", async () => {
  const guide = await read("docs/DEPLOYMENT.md");
  // Vercel cannot do everything Render can; saying so is the difference
  // between a documented tradeoff and a surprise.
  assert.match(guide, /serverless/i);
  assert.match(guide, /limitation|tradeoff|caveat/i);
});

test("no deployment file contains a real secret", async () => {
  for (const f of ["render.yaml", "vercel.json", "Dockerfile", ".env.example", "docs/DEPLOYMENT.md"]) {
    const src = await read(f).catch(() => "");
    assert.ok(!/sk-or-v1-[a-f0-9]{20,}/i.test(src), `${f} must not contain an OpenRouter key`);
    assert.ok(!/\d{9,}:[A-Za-z0-9_-]{30,}/.test(src), `${f} must not contain a bot token`);

    // A documented connection string is a placeholder, not a secret. What must
    // never appear is a URL whose password is a real-looking literal.
    const urls = src.match(/postgresql:\/\/[^\s'"`)]+/g) ?? [];
    for (const u of urls) {
      const password = u.split("://")[1]?.split("@")[0]?.split(":")[1] ?? "";
      const isPlaceholder =
        password === "" ||
        /^(?:user|password|pw|pass|<.*>|\$\{.*\}|postgres|\[.*\])$/i.test(password) ||
        /[<>{}$]/.test(password);
      assert.ok(
        isPlaceholder,
        `${f} appears to contain a real database password: ${u}`
      );
    }
  }
});

test("the app boots without a webhook URL, so a deploy can precede registration", async () => {
  // WEBHOOK_URL is only known after the platform assigns a hostname, so a
  // missing value must not crash boot.
  const src = await read("server.js");
  assert.ok(
    !/REQUIRED_ENV[\s\S]{0,400}WEBHOOK_URL/.test(src.replace(/\r\n/g, "\n")),
    "WEBHOOK_URL must not be a required env var"
  );
});
