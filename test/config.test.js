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
  // The value is now configurable, so the assertion is on the default rather
  // than on a literal at the call site.
  const def = source.match(
    /REQUEST_TIMEOUT_MS = Number\(process\.env\.REQUEST_TIMEOUT_MS \?\? (\d+)\)/
  );
  assert.ok(def, "REQUEST_TIMEOUT_MS must have a default");
  assert.ok(
    Number(def[1]) >= 120000,
    `default timeout ${def[1]}ms is too short for reasoning models`
  );
  assert.match(
    source,
    /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/,
    "the request must actually use the configured timeout"
  );
});

test("a slow model call is logged rather than silently waited on", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.match(
    source,
    /SLOW_CALL_MS/,
    "a free-tier call taking 30s+ must be visible, not indistinguishable from a hang"
  );
  assert.match(source, /was slow/);
});

test("the humanizer is skipped for short replies", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  // Measured at ~35s and ~1800 reasoning tokens to reword a single sentence on
  // a free reasoning model, which is the dominant cost of a short reply.
  assert.match(
    source,
    /HUMANIZE_MAX_CHARS/,
    "short replies must be able to skip the extra model call"
  );
  assert.match(
    source,
    /text\.length <= HUMANIZE_MAX_CHARS/,
    "the skip must actually gate the humanizer call"
  );
  // It must stay switchable: a user who wants it always on can set the flag.
  assert.match(source, /HUMANIZE_SKIP_UNDER/, "the skip must be configurable");
});

test("an unconfigured tool is not advertised to the model", async () => {
  const source = await readFile(path.join(ROOT, "tools.js"), "utf8");
  // Offering a tool that cannot run makes the model call it, read the refusal,
  // and spend another full model pass recovering.
  assert.match(
    source,
    /process\.env\.OWL_API_URL/,
    "owl_research must only be advertised when it is configured"
  );
  const personas = (await readFile(path.join(ROOT, "config.js"), "utf8")).replace(
    /\s+/g,
    " "
  );
  // Collapsed whitespace: the prompt is hard-wrapped for readability, so a
  // literal multi-word match would fail on a reflow and pass for the wrong
  // reason.
  assert.ok(
    personas.includes("only listed for you when research is configured"),
    "the persona must not tell the model it has a tool that may be absent"
  );
  assert.ok(
    personas.includes("Do not pretend to have researched something"),
    "the persona must forbid faking a tool result"
  );
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

// A free-tier generation can come back truncated mid-thought - a measured
// 4-character "Here" where a six-item to-do list was expected, with
// finish_reason still "stop". Sending that is worse than useless.
test("a truncated reply is rejected rather than sent", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.match(
    source,
    /MIN_PLAUSIBLE_REPLY_CHARS/,
    "there must be a floor below which a reply is treated as degenerate"
  );
  const m = source.match(
    /MIN_PLAUSIBLE_REPLY_CHARS = Number\(\s*process\.env\.MIN_PLAUSIBLE_REPLY_CHARS \?\? (\d+)\)/
  );
  assert.ok(m, "the floor must have a default");
  assert.ok(
    Number(m[1]) >= 2,
    "a floor below 2 would reject legitimate one-word answers"
  );
  assert.match(
    source,
    /truncated/,
    "the failure must be identifiable in the logs"
  );
});

test("both model paths require a substantive reply", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  const uses = (source.match(/contentOf\(data, \{ requireSubstance: true \}\)/g) ?? []).length;
  assert.equal(
    uses,
    2,
    "the plain path and the tool-loop path must both reject a degenerate reply"
  );
});

test("a degenerate reply is retried once, not looped", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  assert.match(source, /attempt >= 1/, "the retry must be bounded to one attempt");
  assert.match(source, /retrying once/);
});

test("exactly one callModel is defined (a later one would silently win)", async () => {
  const source = await readFile(path.join(ROOT, "server.js"), "utf8");
  const defs = (source.match(/^async function callModel\(/gm) ?? []).length;
  assert.equal(defs, 1, "a duplicate definition would override the retrying one");
  const contentDefs = (source.match(/^function contentOf\(/gm) ?? []).length;
  assert.equal(contentDefs, 1, "a duplicate contentOf would override the substance check");
});
