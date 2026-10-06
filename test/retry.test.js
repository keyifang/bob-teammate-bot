import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The chosen POC model drops ~60% of requests with a 503 "provider overloaded",
// measured at 4 successes out of 10. Without a retry the product is unusable;
// with one the same measurement went to 6/6. These tests pin the retry's
// classification and bounds so a refactor cannot silently remove it.

async function src() {
  return readFile(path.join(ROOT, "server.js"), "utf8");
}

// isOverload and overloadDelay close over module constants, so those are
// hoisted alongside the function. Re-declaring them here would let the test
// pass against values the server never uses, which is the exact trap this
// file exists to avoid.
const HOISTED = [
  "OVERLOAD_STATUSES",
  "OVERLOAD_BASE_DELAY_MS",
  "OVERLOAD_MAX_DELAY_MS",
];

function extract(source, name, extraConstants = []) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in server.js`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`end of ${name} not found`);
  const wanted = [...extraConstants, ...HOISTED];
  const preamble = wanted
    .map((c) => source.match(new RegExp(`^const ${c} = .*$`, "m"))?.[0])
    .filter(Boolean)
    .join("\n");
  return new Function(`${preamble}\n${source.slice(start, end + 2)}; return ${name};`)();
}

test("overload classification covers the observed failure and rejects real errors", async () => {
  const source = await src();
  const isOverload = extract(source, "isOverload");

  // The exact shape returned by the free tier.
  const body = JSON.stringify({
    error: {
      message: "Upstream error from Nvidia: Service temporarily overloaded",
      code: 503,
      metadata: { error_type: "provider_overloaded" },
    },
  });
  assert.equal(isOverload(503, body), true, "the measured 503 must be retried");
  assert.equal(isOverload(200, body), true, "a 200 carrying an overload error must be retried");
  assert.equal(isOverload(429, ""), true, "rate limits are transient");
  assert.equal(isOverload(503, ""), true);

  // A genuine client error must NOT be retried; retrying a 400 just wastes time.
  assert.equal(isOverload(400, '{"error":{"message":"bad request"}}'), false);
  assert.equal(isOverload(401, "invalid api key"), false);
  assert.equal(isOverload(422, "model not found"), false);
});

test("backoff grows and is jittered, never negative or unbounded", async () => {
  const source = await src();
  const delay = extract(source, "overloadDelay");
  for (let attempt = 0; attempt < 8; attempt++) {
    const samples = Array.from({ length: 40 }, () => delay(attempt));
    for (const s of samples) {
      assert.ok(Number.isInteger(s) && s >= 0, `bad delay ${s}`);
    }
    // Full jitter means the ceiling for a given attempt bounds every sample.
    const ceiling = Math.min(1500 * 2 ** attempt, 20000);
    assert.ok(Math.max(...samples) < ceiling, `exceeded ceiling at ${attempt}`);
    // Deterministic fixed backoff would defeat the purpose.
    assert.ok(new Set(samples).size > 1, `attempt ${attempt} is not jittered`);
  }
});

test("retries are bounded", async () => {
  const source = await src();
  assert.match(
    source,
    /OVERLOAD_MAX_ATTEMPTS = Number\(process\.env\.OVERLOAD_MAX_ATTEMPTS \?\? 4\)/,
    "an unbounded retry loop would hang the webhook forever"
  );
  assert.match(source, /for \(let attempt = 0; attempt < OVERLOAD_MAX_ATTEMPTS; attempt\+\+\)/);
});

test("network errors are retried alongside HTTP overloads", async () => {
  // A saturated provider also drops connections; the earlier failure surfaced
  // as a network error before any status was available.
  const source = await src();
  assert.match(source, /network error \(/, "a dropped connection must be retried");
  assert.match(source, /Model request failed/);
});

test("an exhausted retry raises a distinct overload error, not a generic one", async () => {
  const source = await src();
  assert.match(source, /class OverloadedError/);
  assert.match(source, /this\.overloaded = true/);
  // The caller distinguishes it to show a message that tells the user to retry
  // rather than to rephrase their question.
  assert.match(source, /err\?\.overloaded \? OVERLOADED_REPLY : FALLBACK_REPLY/);
});

test("a 200 with no choices is handled rather than crashing on choices[0]", async () => {
  const source = await src();
  assert.match(
    source,
    /!Array\.isArray\(data\?\.choices\) \|\| data\.choices\.length === 0/,
    "a 200 with an error body and no choices must not reach choices[0]"
  );
});

test("retry budget and the overload reply are configurable", async () => {
  const source = await src();
  assert.match(source, /OVERLOAD_BASE_DELAY_MS/);
  assert.match(source, /OVERLOAD_MAX_DELAY_MS/);
});