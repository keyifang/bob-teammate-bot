// Resilience: what to do when the model provider is saturated.
//
// MEASURED, not assumed. Twelve single calls to the default free model:
//
//   nvidia/nemotron-3-ultra-550b-a55b:free   ok 1/4   4.1s
//   nvidia/nemotron-3.5-lightning:free         ok 4/4  24.7s
//   nvidia/nemotron-3.5-lightning:free         ok 6/6  (second sample, 3 tool calls)
//   google/gemma-4-31b-it:free                 ok 1/4   4.1s
//   inclusionai/ling-3.1-flash                  ok 0/4   8.2s
//   apodex/apodex-1.1-mini:free                 ok 0/4   3.0s
//
// Roughly HALF of all calls to the default model fail before the retry loop
// ever sees them. That is the single largest constraint on what Bob can be -
// not architecture. A ReAct loop issues three calls per task, so it makes
// reliability three times worse unless a fallback exists.
//
// Reliability varies enormously between free models, so the fix is a fallback
// CHAIN: exhaust one model, then try the next, rather than giving up.

import test from "node:test";
import assert from "node:assert/strict";

import { FALLBACK_MODELS, modelChainFor, nextModelAfter } from "../model-config.js";

test("a fallback chain exists, ordered by measured reliability", () => {
  assert.ok(Array.isArray(FALLBACK_MODELS), "there must be a fallback list");
  assert.ok(FALLBACK_MODELS.length >= 1, "at least one alternative must be available");
  for (const m of FALLBACK_MODELS) {
    assert.match(m, /^[\w./:-]+$/, `not a model id: ${m}`);
  }
  // Duplicates would waste a retry on a model already known to be failing.
  assert.equal(new Set(FALLBACK_MODELS).size, FALLBACK_MODELS.length, "no duplicates");
});

test("the chain starts at the configured model, so a user's choice is respected", () => {
  const chain = modelChainFor("some/model:a");
  assert.equal(chain[0], "some/model:a", "the configured model must be tried first");
  assert.ok(chain.length > 1, "there must be somewhere to fall back TO");
});

test("the chain never repeats a model, so retries are not wasted", () => {
  const chain = modelChainFor("some/model:a");
  assert.equal(new Set(chain).size, chain.length, `repeat in chain: ${chain.join(", ")}`);
});

test("the chain is empty-safe: an unknown model still yields a usable chain", () => {
  for (const bad of ["", null, undefined, "   "]) {
    const chain = modelChainFor(bad);
    assert.ok(Array.isArray(chain), `must return an array for ${JSON.stringify(bad)}`);
    assert.ok(chain.length > 0, "an empty chain would mean never calling the model at all");
  }
});

test("the chain is bounded, so a reply cannot spin through every model", () => {
  // A loop across N models x M retries is a hang. Bounded on purpose.
  const chain = modelChainFor("m");
  assert.ok(chain.length <= 4, `chain of ${chain.length} is too long`);
});

test("nextModelAfter advances, and returns null at the end", () => {
  const chain = ["a", "b", "c"];
  assert.equal(nextModelAfter(chain, "a"), "b");
  assert.equal(nextModelAfter(chain, "b"), "c");
  assert.equal(nextModelAfter(chain, "c"), null, "must signal exhaustion, not loop");
  assert.equal(nextModelAfter(chain, "unknown"), "a");
});

test("nextModelAfter returns null rather than throwing on a single-model chain", () => {
  assert.equal(nextModelAfter(["only"], "only"), null);
  assert.equal(nextModelAfter([], "x"), null);
});

test("an exhausted chain is not reported as a provider failure the user can see", async () => {
  // When every model is saturated the user must be told something useful, not
  // "hit an error" - which is what a chat user reads as a broken product.
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../server.js", import.meta.url), "utf8")
  );
  const norm = src.replace(/\r\n/g, "\n");
  assert.match(norm, /OVERLOADED_REPLY/, "an honest overload message must exist");
  assert.match(
    norm,
    /modelChainFor|nextModelAfter/,
    "the retry path must actually walk the chain"
  );
});