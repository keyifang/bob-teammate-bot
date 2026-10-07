// Phase C: the credit ledger.
//
// This is money, so the arithmetic is pure and pinned here. Two things matter
// more than the rest:
//
//   - micro-USD integers, never floats. Repeated float subtraction of a
//     fraction of a cent drifts, and a ledger that drifts is a refund.
//   - the margin guardrail. Credits are priced above cost on purpose; selling
//     below cost means every heavy user is a loss, which is the failure the
//     pricing exists to prevent.

import test from "node:test";
import assert from "node:assert/strict";

import {
  usdToMicro,
  microToUsd,
  costOfCall,
  formatUsd,
  CREDIT_PACKS,
  DEFAULT_MARGIN,
  creditsForPack,
  balanceAfter,
  hasBalance,
  LOW_BALANCE_MICRO,
} from "../credits.js";

test("usdToMicro rounds to whole micro-dollars, never producing a fraction", () => {
  assert.equal(usdToMicro(1), 1_000_000);
  assert.equal(usdToMicro(0.5), 500_000);
  assert.equal(usdToMicro(0), 0);
  // A sub-micro cost rounds to an integer, because the ledger stores integers.
  assert.equal(Number.isInteger(usdToMicro(0.0000001)), true);
  assert.equal(usdToMicro(0.0000001), 0);
  assert.equal(usdToMicro(0.0000006), 1);
});

test("usdToMicro never returns NaN or a negative from bad input", () => {
  for (const bad of [undefined, null, NaN, "abc", -1]) {
    const v = usdToMicro(bad);
    assert.ok(Number.isFinite(v), `${bad} produced ${v}`);
    assert.ok(v >= 0, `${bad} produced a negative`);
  }
});

test("microToUsd is the inverse for whole-cent amounts", () => {
  for (const usd of [0, 0.01, 1, 12.34, 99.99]) {
    assert.equal(microToUsd(usdToMicro(usd)), usd);
  }
});

test("costOfCall multiplies tokens by per-token price and sums prompt and completion", () => {
  // 1000 prompt tokens at $0.15/M and 500 completion at $0.5/M:
  //   1000 * 0.00000015 = 0.00015
  //    500 * 0.0000005  = 0.00025
  //                     = 0.0004
  const micro = costOfCall({
    promptTokens: 1000,
    completionTokens: 500,
    promptPricePerToken: 0.00000015,
    completionPricePerToken: 0.0000005,
  });
  assert.equal(micro, usdToMicro(0.0004));
});

test("costOfCall on a free model is exactly zero, not a rounding artefact", () => {
  assert.equal(
    costOfCall({
      promptTokens: 100_000,
      completionTokens: 50_000,
      promptPricePerToken: 0,
      completionPricePerToken: 0,
    }),
    0
  );
});

test("costOfCall prefers the provider's own reported cost when present", () => {
  // OpenRouter reports usage.cost, which already accounts for cache discounts
  // and provider routing. Recomputing from list prices would overcharge.
  const micro = costOfCall({
    promptTokens: 1000,
    completionTokens: 500,
    promptPricePerToken: 0.00000015,
    completionPricePerToken: 0.0000005,
    reportedCostUsd: 0.0001,
  });
  assert.equal(micro, usdToMicro(0.0001));
});

test("costOfCall ignores a nonsense reported cost and falls back to computing", () => {
  const args = {
    promptTokens: 1000,
    completionTokens: 500,
    promptPricePerToken: 0.00000015,
    completionPricePerToken: 0.0000005,
  };
  for (const bad of [NaN, -1, "x", undefined]) {
    assert.equal(costOfCall({ ...args, reportedCostUsd: bad }), usdToMicro(0.0004));
  }
});

test("a hundred small calls do not drift the ledger", () => {
  // The failure this guards: 100 x 0.000001 subtracted as floats leaves a
  // residue. With integers it is exact.
  const each = usdToMicro(0.000001);
  let balance = usdToMicro(1);
  for (let i = 0; i < 100; i++) balance = balanceAfter(balance, each);
  assert.equal(balance, usdToMicro(1) - 100 * each);
  assert.equal(Number.isInteger(balance), true);
});

test("every credit pack sells for more than the credits it grants", () => {
  // The margin guardrail. If a pack granted more provider-cost-value than its
  // price, every purchase would be a guaranteed loss.
  for (const pack of CREDIT_PACKS) {
    const granted = creditsForPack(pack);
    const priceMicro = usdToMicro(pack.priceUsd);
    assert.ok(
      granted <= priceMicro,
      `pack $${pack.priceUsd} grants ${granted} micro but costs ${priceMicro}`
    );
    assert.ok(pack.priceUsd > 0);
    assert.ok(Number.isInteger(granted));
  }
});

test("the default margin is at least 1, meaning credits never cost less than they sell for", () => {
  assert.ok(DEFAULT_MARGIN >= 1, "a margin below 1 sells below cost");
});

test("formatUsd renders micro-dollars as a readable amount", () => {
  assert.equal(formatUsd(1_000_000), "$1.00");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(12_340_000), "$12.34");
  // Small amounts must not read as $0.00 when they are not zero.
  assert.match(formatUsd(1), /0\.000001/);
});

test("hasBalance is true exactly when the balance covers the cost", () => {
  assert.equal(hasBalance(1000, 1000), true, "spending the last micro is allowed");
  assert.equal(hasBalance(999, 1000), false);
  assert.equal(hasBalance(0, 0), true, "a zero-cost call never needs credit");
  assert.equal(hasBalance(0, 1), false);
});

test("balanceAfter clamps at zero rather than going negative", () => {
  // A race between two calls must not produce a negative balance, which would
  // read as us owing the user.
  assert.equal(balanceAfter(100, 500), 0);
  assert.equal(balanceAfter(500, 100), 400);
});

test("a low-balance warning threshold is a small but non-zero amount", () => {
  assert.ok(LOW_BALANCE_MICRO > 0);
  assert.ok(LOW_BALANCE_MICRO < usdToMicro(1), "the warning must fire before the user is broke");
});

test("packs are ordered smallest to largest so the picker reads naturally", () => {
  const prices = CREDIT_PACKS.map((p) => p.priceUsd);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test("larger packs are a better deal for the user", () => {
  // What the USER receives is creditUsd - the face value on the ledger. That is
  // what must improve with pack size, so buying more is visibly better. (The
  // margin-adjusted creditsForPack is our cost recovery, a different quantity.)
  const bonuses = CREDIT_PACKS.map((p) => p.creditUsd / p.priceUsd);
  for (let i = 1; i < bonuses.length; i++) {
    assert.ok(bonuses[i] >= bonuses[i - 1], `pack ${i} is a worse deal than pack ${i - 1}`);
  }
  // But even the best deal must not grant more provider-value than the price,
  // or the pack is a guaranteed loss.
  for (const pack of CREDIT_PACKS) {
    assert.ok(creditsForPack(pack) <= usdToMicro(pack.priceUsd));
  }
});
