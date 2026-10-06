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
  assert.equal(withinSearchBudget(PLANS.free, 0), true);
  assert.equal(withinSearchBudget(PLANS.free, 1), false, "one search is the free budget");
  assert.equal(withinSearchBudget(PLANS.pro, 4), true);
  assert.equal(withinSearchBudget(PLANS.pro, 5), false);
});

test("allowedHops is always at least one, so the loop can still ask the model", () => {
  assert.equal(allowedHops(PLANS.free), 2);
  assert.equal(allowedHops(PLANS.pro), 6);
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

  const research = quotaMessage("research", PLANS.free);
  assert.match(research, /[Uu]pgrade/);

  // Pluralisation must not read as "5 bots" when the plan allows one.
  assert.match(quotaMessage("bots", PLANS.pro), /5 bots/);
});
