// Telegram commands and inline keyboards.
//
// Two constraints shape this file:
//
//   1. callback_data is capped at 64 bytes. A raw OpenRouter model id is up to
//      39 characters, so embedding it overruns the limit and Telegram silently
//      drops the button. The callback carries an INDEX instead, and the index is
//      resolved back through the registry - so a tampered callback cannot select
//      a model that is not registered.
//
//   2. No server-side state between steps. On serverless an invocation shares no
//      memory with the previous one, so the callback must carry everything
//      needed to act on it. That is why the provider is repeated in a model
//      callback rather than remembered.

import { listProviders, getProvider, getModel } from "./providers.js";
import { CREDIT_PACKS } from "./credits.js";
import { listFormats } from "./export.js";

export const TELEGRAM_CALLBACK_LIMIT = 64;

export const COMMANDS = ["bot_model", "credits", "export", "help"];

/**
 * Splits "/cmd@Bot args" into its parts. Returns null for anything that is not
 * a command, so ordinary chat text is never mistaken for one.
 */
export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();

  // A lone "/" or a command containing another "/" is not a command. Telegram
  // itself rejects a name with a space, and "/not a command/" must stay text
  // rather than becoming the command "not".
  if (!trimmed.startsWith("/") || trimmed.length < 2) return null;
  if (trimmed.indexOf("/", 1) !== -1) return null;

  const m = trimmed.match(/^\/([a-z_][a-z0-9_]{0,31})(?:@[A-Za-z0-9_]+)?(?:[ \t]+([\s\S]*))?$/i);
  if (!m) return null;
  return { command: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

function rows(buttons, perRow = 1) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    out.push(buttons.slice(i, i + perRow));
  }
  return out;
}

export function buildProviderKeyboard() {
  const buttons = listProviders().map((p) => ({
    text: p.label,
    callback_data: `m:p:${p.id}`,
  }));
  return { inline_keyboard: rows(buttons) };
}

export function buildModelKeyboard(providerId) {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const buttons = provider.models.map((m, i) => ({
    // The tier is shown because it decides whether a key is needed.
    text: `${m.label}`,
    callback_data: `m:m:${providerId}:${i}`,
  }));
  return { inline_keyboard: rows(buttons) };
}

export function buildCreditKeyboard() {
  const buttons = CREDIT_PACKS.map((p) => ({
    text: `${p.label} credit`,
    callback_data: `c:${p.id}`,
  }));
  return { inline_keyboard: rows(buttons) };
}

export function buildFormatKeyboard() {
  const buttons = listFormats().map((f) => ({
    text: f.label,
    callback_data: `e:${f.id}`,
  }));
  return { inline_keyboard: rows(buttons, 2) };
}

/**
 * Resolves a callback into an action. Anything malformed, unknown, or from
 * another bot returns action:null so the caller ignores it rather than acting.
 */
export function parseCallback(data) {
  const none = { action: null, provider: null, model: null, pack: null, format: null };
  if (typeof data !== "string" || !data) return none;

  const parts = data.split(":");

  if (parts[0] === "m" && parts[1] === "p" && parts.length === 3) {
    const provider = getProvider(parts[2]);
    if (!provider) return none;
    return { ...none, action: "provider", provider: provider.id };
  }

  if (parts[0] === "m" && parts[1] === "m" && parts.length === 4) {
    const provider = getProvider(parts[2]);
    if (!provider) return none;
    // A strict integer check: parseInt("3abc") is 3, which would let a crafted
    // callback land on a real model it did not name.
    if (!/^\d+$/.test(parts[3])) return none;
    const index = Number(parts[3]);
    const model = provider.models[index];
    if (!model) return none;
    return { ...none, action: "model", provider: provider.id, model: model.id };
  }

  if (parts[0] === "c" && parts.length === 2) {
    const pack = CREDIT_PACKS.find((p) => p.id === parts[1]);
    if (!pack) return none;
    return { ...none, action: "buy", pack: pack.id };
  }

  if (parts[0] === "e" && parts.length === 2) {
    const format = listFormats().find((f) => f.id === parts[1]);
    if (!format) return none;
    return { ...none, action: "export", format: format.id };
  }

  return none;
}

export function describeModelChoice(providerId, modelId) {
  const provider = getProvider(providerId);
  const model = getModel(providerId, modelId);
  if (!provider || !model) return null;
  const keyNote = model.tier === "free" ? "" : " A key is needed for this one.";
  return `${model.label} via ${provider.label}.${keyNote}`;
}
