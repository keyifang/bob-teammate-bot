// Credit ledger arithmetic.
//
// Everything is an integer count of MICRO-dollars (1e-6 USD). Floating-point
// dollars drift under repeated subtraction, and a ledger that drifts is a
// refund argument. All rounding happens at the boundary, in usdToMicro.
//
// Credits are sold at a margin above provider cost on purpose: selling below
// cost means every heavy user is a loss. The guardrail is asserted in the tests
// rather than trusted.

const MICRO = 1_000_000;

export const DEFAULT_MARGIN = 1.4;

export function usdToMicro(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * MICRO);
}

export function microToUsd(micro) {
  const n = Number(micro);
  if (!Number.isFinite(n)) return 0;
  return n / MICRO;
}

/**
 * What one model call cost us.
 *
 * The provider's own reported cost wins when present: OpenRouter's `usage.cost`
 * already accounts for cache discounts and provider routing, so recomputing
 * from list prices would overcharge a user whose request was served cheaply.
 *
 * @returns {number} micro-dollars, always a non-negative integer
 */
export function costOfCall({
  promptTokens = 0,
  completionTokens = 0,
  promptPricePerToken = 0,
  completionPricePerToken = 0,
  reportedCostUsd,
} = {}) {
  const reported = Number(reportedCostUsd);
  if (Number.isFinite(reported) && reported >= 0) return usdToMicro(reported);

  const p = Number(promptTokens) || 0;
  const c = Number(completionTokens) || 0;
  const pp = Number(promptPricePerToken) || 0;
  const cp = Number(completionPricePerToken) || 0;
  return usdToMicro(p * pp + c * cp);
}

export function formatUsd(micro) {
  const usd = microToUsd(micro);
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(2)}`;
}

// Priced so a heavier pack is a better rate, which is what makes buying more
// attractive, while no pack ever grants more provider-value than its price.
export const CREDIT_PACKS = [
  { id: "starter", label: "$5", priceUsd: 5, creditUsd: 5, margin: 1.4 },
  { id: "standard", label: "$10", priceUsd: 10, creditUsd: 10.5, margin: 1.5 },
  { id: "bulk", label: "$25", priceUsd: 25, creditUsd: 27.5, margin: 1.6 },
];

// What a pack actually puts on the ledger. The margin is applied so the user
// receives provider-cost-value equal to price / margin: on a 1.4 margin, $5
// buys $5 of credit but only $3.57 of our provider spend.
export function creditsForPack(pack) {
  const margin = Number(pack?.margin) || DEFAULT_MARGIN;
  return usdToMicro((Number(pack?.creditUsd) || 0) / margin);
}

export function hasBalance(balanceMicro, costMicro) {
  const cost = Number(costMicro) || 0;
  if (cost <= 0) return true;
  return Number(balanceMicro) >= cost;
}

// Clamped at zero: a race between two concurrent calls must not leave a
// negative balance, which would read as us owing the user.
export function balanceAfter(balanceMicro, costMicro) {
  const next = (Number(balanceMicro) || 0) - (Number(costMicro) || 0);
  return next > 0 ? next : 0;
}

export const LOW_BALANCE_MICRO = usdToMicro(0.5);
