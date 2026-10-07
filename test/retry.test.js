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
  // Normalise line endings first. The source is CRLF on a Windows checkout and
  // LF elsewhere; searching for "\n}\n" against CRLF silently found nothing and
  // reported the function as missing.
  const src = source.replace(/\r\n/g, "\n");
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in server.js`);
  const end = src.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`end of ${name} not found`);
  const wanted = [...extraConstants, ...HOISTED];
  const preamble = wanted
    .map((c) => src.match(new RegExp(`^const ${c} = .*$`, "m"))?.[0])
    .filter(Boolean)
    .join("\n");
  return new Function(`${preamble}\n${src.slice(start, end + 2)}; return ${name};`)();
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

// Measured against the live free tier, not assumed. A 3-bot relay turn took
// 19.9s with 4 overloads absorbed, and the overload frequently arrives as a
// 200 carrying an error body rather than a 503 status. A probe that checks
// res.ok and the status alone reports half of them as successful empty
// replies - which is exactly what happened while measuring.
test("the 200-with-error overload shape is recognised, as measured", async () => {
  const source = await src();
  const isOverload = extract(source, "isOverload");

  // The exact body observed from the live provider.
  const live = JSON.stringify({
    error: {
      message: "Upstream error from Nvidia: Service temporarily overloaded",
      code: 503,
      metadata: { error_type: "provider_overloaded" },
    },
  });
  // Status is 200 - which is why status alone is not enough.
  assert.equal(isOverload(200, live), true, "a 200 carrying this error must be retried");
});

test("the retry loop checks for overload in a 200 body, not only a bad status", async () => {
  const source = await src();
  // The loop must detect the no-choices shape, which is how a 200-with-error
  // presents.
  assert.match(
    source,
    /isOverload\(200, text\)/,
    "the 200-with-error case must be classified as an overload"
  );
  assert.match(source, /returned no choices/, "and must be retried as one");
});

// A failed tool must not become a refusal.
//
// OBSERVED live (2026-10-08): asked for Singapore's PSI, web_search failed, and
// Bob replied "can't look it up right now - search is hitting a limit". The user
// pushed back with "you can actually do webfetch", and Bob then emitted raw
// tool-call markup into the chat instead of fetching the page it had just been
// told about.
//
// The general rule: a failure in one tool is a reason to try ANOTHER tool, and
// only a reason to say "I can't" once every relevant tool has failed.
test("a tool failure instructs the model to try another tool, not to refuse", async () => {
  const source = await src();
  const i = source.indexOf("Tool failed:");
  assert.ok(i > 0, "a failed tool must report something to the model");
  const window = source.slice(i, i + 700);

  // The model is told what to do NEXT. Without this it treats one failure as
  // "no information available" and tells the user it cannot look anything up.
  assert.match(
    window,
    /another tool|try it now|every relevant tool/i,
    "a failed tool must prompt a fallback attempt"
  );
  assert.match(
    window,
    /rate limited|unavailable/,
    "the fallback instruction must explicitly contradict the excuse the model invented"
  );
});

test("the persona forbids treating one failed tool as a general refusal", async () => {
  const { PERSONA_SYSTEM_PROMPT } = await import("../config.js");
  assert.match(
    PERSONA_SYSTEM_PROMPT,
    /when one tool fails/i,
    "the general rule must be in the persona, not only in the tool error text"
  );
  assert.match(
    PERSONA_SYSTEM_PROMPT,
    /never as an excuse not to try/i,
    "and it must forbid using a limitation as a reason not to try"
  );
  assert.ok(
    !/say plainly that you cannot look it up/.test(PERSONA_SYSTEM_PROMPT),
    "the old wording taught the model to refuse whenever a tool was unavailable"
  );
});

test("protocol markup is rejected in content, so a broken tool call never posts", async () => {
  // The second half of the same incident: after being pushed back, the model
  // emitted <tool_call> markup as text. That reached the chat verbatim.
  const source = await src();
  assert.match(source, /TOOL_CALL_MARKUP_RE/, "protocol markup must be detected");
  assert.match(
    source,
    /visibleOnly/,
    "and invisible characters must be stripped first, or a zero-width space slips past"
  );
});
