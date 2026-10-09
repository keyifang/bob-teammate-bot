// Phase 8: plans and quotas.
//
// The pricing model is $1/bot/month, but a flat per-bot price makes 1 bot and
// 20 bots feel like the same product while all of them run on our compute and
// our model key. So the plan controls CAPABILITY as well as count: how many
// searches a message may run and how many tool hops it may take. Those caps are
// also what stops bots ping-ponging in a group, which would burn quota and
// annoy the group.
//
// Everything here is pure so the rules can be tested without a database.

// Budgets are sized to ANSWER A QUESTION, not to ration it.
//
// A weather or PSI question naturally needs search -> fetch -> possibly one
// more search. The original free budget of ONE search and TWO hops made that
// sequence impossible: the model hit the cap mid-answer and told the user it
// had "hit the research limit", which reads as a broken product.
//
// The cap still exists, because an uncapped loop burns quota and lets two bots
// ping-pong in a group. It is simply no longer tight enough to refuse the
// questions the product exists to answer.
export const PLANS = {
  free: {
    id: "free",
    botQuota: 1,
    searchesPerMessage: 4,
    toolHops: 5,
    selectableModel: false,
  },
  pro: {
    id: "pro",
    botQuota: 5,
    searchesPerMessage: 8,
    toolHops: 8,
    selectableModel: true,
  },
  pro_plus: {
    id: "pro_plus",
    botQuota: Infinity,
    searchesPerMessage: 12,
    toolHops: 10,
    selectableModel: true,
  },
};

export const DEFAULT_PLAN_ID = "free";

// An unknown, missing or inactive subscription resolves to the free plan rather
// than throwing: a billing hiccup must not take a working bot offline, and it
// must not silently grant paid capability either.
export function resolvePlan(subscription) {
  if (!subscription) return PLANS[DEFAULT_PLAN_ID];
  if (subscription.status && subscription.status !== "active") {
    return PLANS[DEFAULT_PLAN_ID];
  }
  return PLANS[subscription.plan] ?? PLANS[DEFAULT_PLAN_ID];
}

export function withinBotQuota(plan, currentBotCount) {
  return currentBotCount < plan.botQuota;
}

export function withinSearchBudget(plan, searchesUsed) {
  return searchesUsed < plan.searchesPerMessage;
}

// The hop budget is what the tool loop iterates to. It is bounded below by 1 so
// a misconfigured plan cannot produce a loop that never asks the model anything.
export function allowedHops(plan) {
  const hops = Number(plan?.toolHops ?? PLANS[DEFAULT_PLAN_ID].toolHops);
  if (!Number.isFinite(hops) || hops < 1) return 1;
  return Math.floor(hops);
}

// A user-facing explanation, so a refusal says what to do rather than just no.
export function quotaMessage(kind, plan) {
  if (kind === "bots") {
    return (
      `Your plan includes ${plan.botQuota} bot${plan.botQuota === 1 ? "" : "s"}. ` +
      "Upgrade to add more."
    );
  }
  // Read by the MODEL, and it is relayed to the user whenever the model decides
  // to paraphrase it - observed live as "Hit the research limit for this
  // message - can't pull Melbourne weather right now." So it is phrased as an
  // instruction to answer with what is already in hand, and contains no
  // apology, no "can't", and no mention of plans or limits for a user to read.
  return (
    "No more searches are available for this message. Answer now using the " +
    "results you already have, and say plainly which specific detail you could " +
    "not confirm. Do not mention limits, plans or tooling to the user."
  );
}
