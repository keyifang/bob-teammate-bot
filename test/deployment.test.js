// Phase 9: deployment config.
//
// These checks are structural on purpose: they catch the drift that is
// invisible locally and only shows up as a broken deploy. schema.sql claims to
// mirror ensureSchema(), and it had already fallen behind by two phases - which
// is exactly the failure these tests exist to prevent.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFile(path.join(ROOT, f), "utf8");

// Every table ensureSchema() creates, read from the source rather than
// hardcoded, so adding a table to db.js without adding it here fails.
function tablesInSchemaStatements(src) {
  return [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
}

function tablesInSqlFile(src) {
  return [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)].map((m) => m[1]);
}

test("the table extractor finds tables (negative control)", () => {
  const sample = "CREATE TABLE IF NOT EXISTS alpha (x INT)";
  assert.deepEqual(tablesInSchemaStatements(sample), ["alpha"]);
  assert.deepEqual(tablesInSqlFile(sample.toLowerCase()), ["alpha"]);
  // And it must not invent tables from a line that creates none.
  assert.deepEqual(tablesInSchemaStatements("CREATE INDEX IF NOT EXISTS i ON t (c)"), []);
});

test("schema.sql creates every table ensureSchema() creates", async () => {
  const dbSrc = await read("db.js");
  const sqlSrc = await read("schema.sql");
  const fromCode = new Set(tablesInSchemaStatements(dbSrc));
  const fromSql = new Set(tablesInSqlFile(sqlSrc));

  const missing = [...fromCode].filter((t) => !fromSql.has(t));
  assert.deepEqual(
    missing,
    [],
    `schema.sql is missing: ${missing.join(", ")}. It claims to mirror ensureSchema().`
  );
});

test("schema.sql invents no table the app does not use", async () => {
  const dbSrc = await read("db.js");
  const sqlSrc = await read("schema.sql");
  const fromCode = new Set(tablesInSchemaStatements(dbSrc));
  const fromSql = new Set(tablesInSqlFile(sqlSrc));
  const extra = [...fromSql].filter((t) => !fromCode.has(t));
  assert.deepEqual(extra, [], `schema.sql has tables db.js never creates: ${extra.join(", ")}`);
});

test("render.yaml is valid JSON with a docker service and a health check", async () => {
  const cfg = JSON.parse(await read("render.yaml"));
  const svc = cfg.services?.[0];
  assert.ok(svc, "render.yaml must declare a service");
  assert.equal(svc.runtime, "docker");
  assert.equal(svc.healthCheckPath, "/health", "a health check is what makes deploys detectable");
  assert.equal(svc.dockerfilePath, "Dockerfile");
});

test("render.yaml requires every secret rather than shipping a value", async () => {
  const cfg = JSON.parse(await read("render.yaml"));
  const vars = Object.fromEntries(
    (cfg.services[0].envVars ?? []).map((v) => [v.key, v])
  );

  for (const key of ["TELEGRAM_BOT_TOKEN", "MODEL_API_KEY", "DATABASE_URL", "WEBHOOK_SECRET"]) {
    assert.ok(vars[key], `${key} must be declared`);
    assert.equal(
      vars[key].sync,
      false,
      `${key} is a secret and must not carry a committed value`
    );
    assert.equal(vars[key].value, undefined, `${key} must have no value in the repo`);
  }
});

test("render.yaml sets no port, because the platform injects it", async () => {
  const cfg = JSON.parse(await read("render.yaml"));
  const keys = (cfg.services[0].envVars ?? []).map((v) => v.key);
  assert.ok(!keys.includes("PORT"), "hardcoding PORT breaks the platform's routing");
});

test("render.yaml's model default matches the one the app documents", async () => {
  const cfg = JSON.parse(await read("render.yaml"));
  const vars = Object.fromEntries((cfg.services[0].envVars ?? []).map((v) => [v.key, v]));
  const example = await read(".env.example");
  const exampleModel = example.match(/^MODEL_NAME=(.*)$/m)?.[1]?.trim();
  assert.ok(exampleModel, ".env.example must document MODEL_NAME");
  assert.equal(
    vars.MODEL_NAME?.value,
    exampleModel,
    "the deploy default and the documented default must not disagree"
  );
});

test("the Dockerfile installs Python, which the search backend requires", async () => {
  const dockerfile = await read("Dockerfile");
  // Without Python the only search path left is the scraped endpoint, which
  // serves bot-detection challenge pages.
  assert.match(dockerfile, /python3/);
  assert.match(dockerfile, /ddgs/);
  assert.match(dockerfile, /httpx>=0\.28/, "an older httpx breaks ddgs");
});

test("the image excludes the .env file and the tests", async () => {
  const ignore = await read(".dockerignore");
  for (const entry of [".env", "node_modules", "test"]) {
    assert.ok(
      ignore.split("\n").includes(entry),
      `${entry} must be excluded from the image`
    );
  }
});

test("the image runs as a non-root user", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /^USER (?!root)\w+/m, "a root container is unnecessary risk");
});

test("no deployment file embeds a real secret", async () => {
  const files = ["render.yaml", "Dockerfile", ".env.example", "schema.sql", "README.md"];
  for (const file of files) {
    const src = await read(file).catch(() => "");
    assert.ok(
      !/sk-or-v1-[a-f0-9]{20,}/i.test(src),
      `${file} must not contain an OpenRouter key`
    );
    assert.ok(
      !/\d{9,}:[A-Za-z0-9_-]{30,}/.test(src),
      `${file} must not contain a Telegram bot token`
    );
  }
});
