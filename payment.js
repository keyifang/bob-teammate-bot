// Payments via Stripe.
//
// The whole design rests on one rule: **credit is granted only on a
// signature-verified webhook.** Trusting the browser's success redirect would
// let anyone mint credit by visiting a URL, so the redirect is used only to
// tell the user to come back - never to grant anything.
//
// The webhook is also idempotent, because Stripe retries. A replayed event
// granting credit twice is the same class of bug as a replayed Telegram update,
// and is handled the same way: the event id is claimed in Postgres first.

import crypto from "node:crypto";
import { CREDIT_PACKS, creditsForPack } from "./credits.js";

// Stripe's own default. A signature older than this is refused, so a captured
// request cannot be replayed indefinitely.
export const STRIPE_TOLERANCE_SECONDS = 300;

export function paymentsConfigured(env = process.env) {
  if (!env) return false;
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

// Kill-switch for free testing, without removing the integration.
//
// Defaults to ON: an unset variable must leave the real behaviour alone, because
// guessing wrong here silently stops paying customers. Only an explicit false
// value disables, so a typo cannot disable purchasing by accident.
//
// Set CREDIT_PURCHASES_ENABLED=false to test the AI freely; unset it to sell.
const DISABLED_VALUES = new Set(["false", "0", "no", "off"]);

export function purchasesEnabled(env = process.env) {
  if (!env) return true;
  const raw = String(env.CREDIT_PURCHASES_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !DISABLED_VALUES.has(raw);
}

/**
 * Verifies a Stripe webhook signature.
 *
 * The comparison is constant-time: a timing-unsafe `===` leaks the expected
 * signature one byte at a time, which is enough to forge one.
 */
export function verifyStripeSignature(payload, header, secret, { now = Date.now() } = {}) {
  if (typeof header !== "string" || !header) return { ok: false, error: "missing signature" };
  if (typeof secret !== "string" || !secret) return { ok: false, error: "no webhook secret" };

  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );

  const timestamp = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(timestamp) || !v1) return { ok: false, error: "malformed signature" };

  const age = Math.abs(Math.floor(now / 1000) - timestamp);
  if (age > STRIPE_TOLERANCE_SECONDS) return { ok: false, error: "signature too old" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  if (a.length !== b.length) return { ok: false, error: "signature mismatch" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, error: "signature mismatch" };

  return { ok: true };
}

/**
 * Pulls the few fields the handler needs out of an event body.
 *
 * Returns null rather than throwing on malformed JSON: a webhook handler that
 * throws returns a 500, and Stripe then retries a request that can never
 * succeed.
 */
export function parseStripeEvent(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const object = parsed.data?.object ?? {};
  return {
    id: parsed.id ?? null,
    type: parsed.type ?? null,
    // client_reference_id carries the Telegram user id, set when the session
    // was created - so credit lands on the right account.
    userId: object.client_reference_id ?? object.metadata?.user_id ?? null,
    pack: object.metadata?.pack ?? null,
    sessionId: object.id ?? null,
  };
}

/**
 * How much credit a pack grants.
 *
 * The amount comes from OUR pack table, never from the request body - a
 * tampered payload could otherwise ask for any balance it liked.
 */
export function creditForCheckout(packId) {
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) return null;
  return creditsForPack(pack);
}

// --- Stripe API calls -------------------------------------------------------
//
// Plain fetch, not the SDK: three calls do not justify a dependency, and the
// form encoding Stripe expects is simple.

const STRIPE_API = "https://api.stripe.com/v1";

async function stripePost(path, params, env = process.env) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe ${path} failed: ${res.status} ${data?.error?.message ?? ""}`);
  }
  return data;
}

/**
 * Creates a Checkout Session for a credit pack.
 *
 * `client_reference_id` is the Telegram user id: it is how the webhook knows
 * whose balance to credit, and it comes back on the event.
 */
export async function createCheckoutSession({ packId, userId, successUrl, cancelUrl }, env = process.env) {
  if (!paymentsConfigured(env)) throw new Error("payments are not configured");
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error(`unknown pack: ${packId}`);

  const params = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(Math.round(pack.priceUsd * 100)),
    "line_items[0][price_data][product_data][name]": `Bob credit ${pack.label}`,
    // Verified live: Stripe rejects inline price_data without a tax code
    // ("the product tax code is missing"). Digital credit is not a physical
    // good, so it takes the generic SaaS code.
    "line_items[0][price_data][product_data][tax_code]": "txcd_10000000",
    client_reference_id: String(userId),
    "metadata[pack]": pack.id,
    "metadata[user_id]": String(userId),
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  return stripePost("/checkout/sessions", params, env);
}
