// Phase 8: plans and quotas.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PLANS,
  resolvePlan,
  withinBotQuota,
  withinSearchBudget,
  allowedHops,
  quotaMessage,
} from "../quota.js";

test("the free plan is the default for every missing or unusable subscription", () => {
  assert.equal(resolvePlan(null).id, "free");
  assert.equal(resolvePlan(undefined).id, "free");
  assert.equal(resolvePlan({}).id, "free", "an empty subscription is not a paid one");
  // An unknown plan name must not grant paid capability.
  assert.equal(resolvePlan({ plan: "enterprise_free_lunch" }).id, "free");
});

test("an inactive subscription does not grant paid capability", () => {
  for (const status of ["canceled", "past_due", "unpaid", "trialing_ended"]) {
    assert.equal(
      resolvePlan({ plan: "pro", status }).id,
      "free",
      `status ${status} must fall back to free`
    );
  }
  assert.equal(resolvePlan({ plan: "pro", status: "active" }).id, "pro");
});

test("a known active plan is honoured", () => {
  assert.equal(resolvePlan({ plan: "pro", status: "active" }).id, "pro");
  assert.equal(resolvePlan({ plan: "pro_plus", status: "active" }).id, "pro_plus");
});

test("bot quota is exclusive: a plan of 5 allows the 5th, not the 6th", () => {
  const pro = PLANS.pro;
  assert.equal(withinBotQuota(pro, 0), true);
  assert.equal(withinBotQuota(pro, 4), true);
  assert.equal(withinBotQuota(pro, 5), false, "the 6th bot must be refused");
});

test("a free plan allows one bot and refuses the second", () => {
  assert.equal(withinBotQuota(PLANS.free, 0), true);
  assert.equal(withinBotQuota(PLANS.free, 1), false);
});

test("an unlimited plan never refuses on count", () => {
  assert.equal(withinBotQuota(PLANS.pro_plus, 100000), true);
});

test("search budget is exclusive and per message, not cumulative", () => {
  // Asserted against the PLAN's own number rather than a literal, so raising a
  // budget does not silently invalidate the rule being tested.
  assert.equal(withinSearchBudget(PLANS.free, 0), true);
  assert.equal(withinSearchBudget(PLANS.free, PLANS.free.searchesPerMessage - 1), true);
  assert.equal(
    withinSearchBudget(PLANS.free, PLANS.free.searchesPerMessage),
    false,
    "the last allowed search is permitted; one more is not"
  );
  assert.equal(withinSearchBudget(PLANS.pro, PLANS.pro.searchesPerMessage), false);
});

test("allowedHops is always at least one, so the loop can still ask the model", () => {
  assert.equal(allowedHops(PLANS.free), PLANS.free.toolHops);
  assert.equal(allowedHops(PLANS.pro), PLANS.pro.toolHops);
  // A misconfigured plan must not produce a loop that never reaches the model.
  assert.equal(allowedHops({ toolHops: 0 }), 1);
  assert.equal(allowedHops({ toolHops: -3 }), 1);
  assert.equal(allowedHops({ toolHops: "nonsense" }), 1);
  // No plan at all falls back to the free plan's budget, which is still >= 1.
  assert.equal(allowedHops({}), PLANS.free.toolHops);
  assert.equal(allowedHops(null), PLANS.free.toolHops);
  assert.ok(allowedHops(null) >= 1);
  // A fractional budget is floored, never rounded up past the plan.
  assert.equal(allowedHops({ toolHops: 2.9 }), 2);
});

test("paid plans are strictly more capable than free, in every dimension", () => {
  const free = PLANS.free;
  for (const paid of [PLANS.pro, PLANS.pro_plus]) {
    assert.ok(paid.botQuota >= free.botQuota);
    assert.ok(paid.searchesPerMessage >= free.searchesPerMessage);
    assert.ok(paid.toolHops >= free.toolHops);
  }
  assert.equal(free.selectableModel, false, "model choice is a paid capability");
});

test("a refusal explains what to do, not just no", () => {
  const bots = quotaMessage("bots", PLANS.free);
  assert.match(bots, /1 bot/);
  assert.match(bots, /[Uu]pgrade/);

  // The RESEARCH refusal is the exception: it is read by the model and gets
  // relayed to the user, so it must not read as a user-facing apology at all.
  // That is asserted separately, in "the search-budget refusal is addressed to
  // the model, not the user".
  const research = quotaMessage("research", PLANS.free);
  assert.match(research, /answer/i);

  // Pluralisation must not read as "5 bots" when the plan allows one.
  assert.match(quotaMessage("bots", PLANS.pro), /5 bots/);
});

// A budget must never become an apology to the user.
//
// OBSERVED live (2026-10-08): asked for Melbourne's weather, Bob replied "Hit
// the research limit for this message - can't pull Melbourne weather right now."
// The free plan allows ONE search, the model wanted a second, and the refusal
// text handed back to it was RELAYED TO THE USER verbatim.
//
// An internal budget is not the user's problem, and a user who sees "research
// limit" on a free weather question concludes the product is broken - which it
// was. The refusal exists to steer the MODEL, so it must read as an instruction
// and must never sound like something to say out loud.
test("the search-budget refusal is addressed to the model, not the user", async () => {
  const { quotaMessage } = await import("../quota.js");
  const msg = quotaMessage("research", { searchesPerMessage: 1, botQuota: 1 });

  // It must not read like a user-facing apology.
  assert.ok(
    !/sorry|can't|cannot|unable|try again|upgrade/i.test(msg),
    `the refusal is fed to the model and gets relayed; it must not read as a user message: ${msg}`
  );
  // It must instruct the model what to do instead.
  assert.match(msg, /answer|use|already|enough/i, "it must tell the model to answer with what it has");
});

test("the free plan allows enough searches for an ordinary question", async () => {
  const { PLANS } = await import("../quota.js");
  // A weather or PSI question needs search -> fetch -> possibly one more search.
  // One search is not enough to answer the questions this product exists for.
  assert.ok(
    PLANS.free.searchesPerMessage >= 3,
    `free allows ${PLANS.free.searchesPerMessage} search(es); that refuses ordinary questions`
  );
});

test("tool hops are enough to actually use those searches", async () => {
  const { PLANS, allowedHops } = await import("../quota.js");
  // A hop is one round trip. Searching, then fetching, then answering needs at
  // least three; a budget of 2 makes the search allowance unreachable.
  assert.ok(
    allowedHops(PLANS.free) >= 4,
    `free allows ${allowedHops(PLANS.free)} hops; the search budget cannot be spent`
  );
});
