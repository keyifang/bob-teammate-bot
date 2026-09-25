import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Regression: a live boot against the real .env failed with
// "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string" because
// db.js read DATABASE_URL while being imported - and ES module imports run
// before the importing module's own body, so dotenv.config() in server.js came
// too late. The e2e suite missed it by injecting DATABASE_URL into the child
// environment, i.e. working around the very bug it should have caught.

// Negative control: the structural check below must be able to fail. A checker
// that always returns true makes every assertion here vacuous.
function firstImportLineIsEnv(source) {
  const match = source.match(/^\s*import\s+.*?["'](\.[^"']+)["']/);
  return match?.[1] ?? null;
}

test("the env-ordering checker rejects the buggy shape (negative control)", () => {
  const buggy = `import express from "express";\nimport dotenv from "dotenv";\ndotenv.config();\n`;
  assert.notEqual(firstImportLineIsEnv(buggy), "./env.js");
});

test("server.js loads env.js before any module that reads process.env", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  const first = firstImportLineIsEnv(source);
  assert.equal(first, "./env.js", `first relative import was ${first}, expected ./env.js`);

  // Nothing in server.js may re-implement dotenv, which would reintroduce the
  // same ordering hazard in a way that looks correct.
  assert.ok(
    !/dotenv\.config\(/.test(source),
    "server.js must not call dotenv.config() itself"
  );
});

test("register-webhook.js loads env.js the same way", async () => {
  const source = await readFile(path.join(ROOT, "register-webhook.js"), "utf8");
  assert.equal(firstImportLineIsEnv(source), "./env.js");
  assert.ok(!/dotenv\.config\(/.test(source));
});

// Asserted behaviourally rather than by pattern-matching the source: a
// regex cannot tell a module-scope pool from a lazy one inside a function,
// and a source-shape check that cannot actually detect the bug is worse than
// no check at all.
test("importing db.js with no DATABASE_URL does not build a pool or throw", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    // The buggy version constructs pg.Pool at module scope from an undefined
    // connection string, which throws or dangles on import. This must import
    // cleanly.
    const mod = await import(`../db.js?lazy=${Date.now()}`);
    assert.ok(typeof mod.getMessageCount === "function");
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test("db.js fails with a named error when DATABASE_URL is absent", async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const mod = await import(`../db.js?lazy2=${Date.now()}`);
    await assert.rejects(
      () => mod.getMessageCount(1),
      /DATABASE_URL is not set/,
      "must not surface as a confusing SASL/pg error"
    );
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test("db.js does not embed a connection string in its source", async () => {
  const source = await readFile(path.join(ROOT, "db.js"), "utf8");
  assert.ok(
    !/postgres(ql)?:\/\/[^\s"']*:[^\s"']*@/.test(source),
    "credentials must come from the environment, never be hardcoded"
  );
});

// Deployment safety. A live .env exists in this working tree; if it were ever
// copied into a container image or committed, real bot tokens and API keys
// would be published.
test("the .env file is excluded from the container image", async () => {
  const raw = await readFile(path.join(ROOT, ".dockerignore"), "utf8");
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const excluded = new Set(lines.filter((l) => !l.startsWith("!") && !l.startsWith("#")));
  const reIncluded = new Set(lines.filter((l) => l.startsWith("!")).map((l) => l.slice(1)));

  assert.ok(excluded.has(".env"), ".env must be in .dockerignore");
  assert.ok(!reIncluded.has(".env"), ".env must not be re-included by a ! rule");
});

test("the .env file is gitignored", async () => {
  const raw = await readFile(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(raw, /^\.env$/m, "committing .env would publish the bot token");
});

test("ensureSchema issues one statement per query (pooler compatibility)", async () => {
  // Supabase's connection pooler runs in transaction mode and rejects a
  // multi-statement query string, so the DDL must not be sent as one blob.
  const source = await readFile(path.join(ROOT, "db.js"), "utf8");
  const schemaFn = source.slice(source.indexOf("export async function ensureSchema"));
  assert.ok(
    /for \(const statement of/.test(schemaFn),
    "ensureSchema must loop over separate statements"
  );
  assert.ok(
    !/query\(`[^`]*;[^`]*`\)/.test(schemaFn),
    "ensureSchema must not send multiple statements in one query"
  );
});

test("the pool size is capped for a pooler-backed database", async () => {
  const source = await readFile(path.join(ROOT, "db.js"), "utf8");
  assert.match(source, /max:\s*Number\(process\.env\.PGPOOL_MAX/, "pool max must be configurable and bounded");
});

// Provider portability. These variables are deliberately generic so the model
// backend can be swapped in .env alone; a hardcoded provider name or key in
// the source would undo that and reintroduce a credential in the repo.
test("server.js has no provider-specific variable names", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  for (const name of ["DEEPSEEK_", "OPENAI_", "OPENROUTER_"]) {
    assert.ok(
      !source.includes(name),
      `server.js still references ${name}; use the provider-agnostic MODEL_* names`
    );
  }
});

test("server.js inlines no model key or provider hostname", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.ok(!/sk-[a-zA-Z0-9_-]{16,}/.test(source), "looks like an inlined API key");
  assert.ok(
    !/https:\/\/(api\.deepseek\.com|openrouter\.ai)/.test(source),
    "provider endpoint must come from the environment"
  );
});

test("the model request carries OpenRouter attribution headers", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.match(source, /"HTTP-Referer"\] = "https:\/\/keyi\.ai"/);
  assert.match(source, /"X-Title"\] = "KeYiCode CLI"/);
  assert.match(source, /"X-OpenRouter-Categories"\]/);
});

test("token budgets are configurable and exceed a reasoning model's overhead", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  // A reasoning model spent 194 of 203 completion tokens thinking on a
  // six-character answer, so a budget in the hundreds truncates the reply.
  const reply = source.match(/REPLY_MAX_TOKENS = Number\(process\.env\.REPLY_MAX_TOKENS \?\? (\d+)\)/);
  assert.ok(reply, "REPLY_MAX_TOKENS must have a default");
  assert.ok(Number(reply[1]) >= 2000, `reply budget too small for reasoning: ${reply[1]}`);

  const summary = source.match(/SUMMARY_MAX_TOKENS = Number\(process\.env\.SUMMARY_MAX_TOKENS \?\? (\d+)\)/);
  assert.ok(summary, "SUMMARY_MAX_TOKENS must have a default");
  assert.ok(
    Number(summary[1]) >= Number(reply[1]),
    "summarisation folds a whole batch and needs at least the reply budget"
  );

  // No call site may still use the old hardcoded 500.
  assert.ok(
    !/max_tokens:\s*500\b/.test(source),
    "a hardcoded 500-token budget will truncate reasoning models"
  );
});

test("the request timeout outlasts a slow reasoning tool call", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  const m = source.match(/AbortSignal\.timeout\((\d+)\)/);
  assert.ok(m, "a request timeout must be set");
  // Measured at ~66s for one tool-calling turn on a free reasoning model.
  assert.ok(Number(m[1]) >= 120000, `timeout ${m[1]}ms is too short for reasoning models`);
});

test("reasoning tokens are surfaced in the usage log", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.match(
    source,
    /completion_tokens_details\?\.reasoning_tokens/,
    "reasoning tokens must be broken out or a free model looks like it is spending"
  );
  assert.match(source, /usage\.cost/, "OpenRouter's reported cost must be logged");
});
