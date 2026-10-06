// Phase 4: requirements 3-5 - knowing what Bob does not know.
//
// Pure prompt work, and the biggest perceived win in the plan: Bob must treat
// anything that could have changed since training as something to look up, not
// to recall; must check whether what it found actually answers the question;
// and must say so plainly rather than fill the gap from memory.

import test from "node:test";
import assert from "node:assert/strict";

import { PERSONA_SYSTEM_PROMPT } from "../config.js";

test("the persona warns that training data has a cutoff", () => {
  assert.match(
    PERSONA_SYSTEM_PROMPT,
    /training data has a cutoff|training data is (?:stale|out of date)|knowledge cutoff/i,
    "the persona must name the cutoff explicitly"
  );
});

test("the persona lists the kinds of thing that must be looked up, not recalled", () => {
  // Naming the categories is what makes the rule actionable; "check if unsure"
  // is not, because a model is never unsure.
  for (const word of ["prices", "versions", "latest", "current"]) {
    assert.ok(
      new RegExp(word, "i").test(PERSONA_SYSTEM_PROMPT),
      `the freshness rule should mention "${word}"`
    );
  }
});

test("the persona requires a sufficiency check before answering", () => {
  assert.match(
    PERSONA_SYSTEM_PROMPT,
    /do the results actually answer|actually answer the question|whether the results answer/i,
    "a search must be judged for whether it answers the question"
  );
  assert.match(
    PERSONA_SYSTEM_PROMPT,
    /never fill the gap from memory|instead of guessing|do not guess|not guess/i,
    "an unanswered question must be admitted, not guessed"
  );
});

test("the persona keeps caveats earned, not blanket", () => {
  // A disclaimer on every message would violate the short-and-human rule, so
  // the caveat rule must be conditional, not unconditional.
  assert.match(
    PERSONA_SYSTEM_PROMPT,
    /only when|caveat only|when it changes/i,
    "caveats must be conditional, not applied to every reply"
  );
  assert.ok(
    !/always (?:add|include) a (?:caveat|disclaimer)/i.test(PERSONA_SYSTEM_PROMPT),
    "a blanket caveat rule would break the brevity rule"
  );
});

test("the persona still forbids padding, so freshness rules do not undo brevity", () => {
  assert.match(PERSONA_SYSTEM_PROMPT, /1-3 sentences/i);
  assert.match(PERSONA_SYSTEM_PROMPT, /No preamble/i);
});

test("the persona still forbids pretending to have researched", () => {
  assert.match(PERSONA_SYSTEM_PROMPT, /do not pretend/i);
});
