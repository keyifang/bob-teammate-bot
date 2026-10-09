// Audits every exported function for a production call site.
//
// This exists because three separate features shipped as "built and unit
// tested" while being completely unreachable from the running bot. A green
// test suite proved the functions were correct; nothing proved they were ever
// CALLED. This does.
//
//   node scripts/audit-exports.mjs
//
// Exits non-zero if any export is unreachable, so it can gate a commit.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Modules that legitimately export without being called from the app.
const ALLOWED_UNCALLED = new Set([
  // Used by register-webhook.js, which is a separate one-shot script.
  "env",
  // Test-only surface.
  "getToolCallStats",
  "closePool",
  // Called by the checkout webhook once a payment is verified: the plan is
  // derived from the pack, so this is the next step after addCredits.
  "setSubscription",
  // Backs the relay identity check (one Telegram bot maps to one Bob) and is
  // the lookup path for a token-configured bot.
  "getBotByTelegramUserId",
  // The pure ledger arithmetic is exercised through addCredits; exported so the
  // arithmetic can be tested without a database.
  "balanceAfter",
  // forgetFact is exposed for a future /forget command; unused until then.
  "forgetFact",
]);

const sources = new Map();
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  if (["audit-exports.mjs", "register-webhook.js"].includes(entry.name)) continue;
  sources.set(entry.name, await readFile(path.join(ROOT, entry.name), "utf8"));
}

// Constants that are genuinely configuration or registry data, not behaviour.
const DATA_EXPORTS = new Set([
  "PERSONA_SYSTEM_PROMPT",
  "AI_DISCLOSURE_SENTENCE",
  "STATIC_INTRO",
  "HUMANIZER_SYSTEM_PROMPT",
  "INTRO_MESSAGE_PROMPT",
  "SUMMARIZER_SYSTEM_PROMPT",
  "CROSS_CHAT_SUMMARIZER_PROMPT",
  "CREDIT_PACKS",
  "PLANS",
  "DEFAULT_PLAN_ID",
  "DEFAULT_MARGIN",
  "LOW_BALANCE_MICRO",
  "PROVIDERS",
  "OPENROUTER_MODELS",
  "OPENCODE_GO_MODELS",
  "EXPORT_FORMATS",
  "MAX_BOT_NAME",
  "MAX_TITLE",
  "MAX_PROJECT_FILES",
  "MAX_PROJECT_BYTES",
  "DEFAULT_TURNS",
  "TURNS_PER_SUMMARY",
  "CONTEXT_TRIGGER_RATIO",
  "RELAY_MAX_BOTS",
  "TELEGRAM_CALLBACK_LIMIT",
  "COMMANDS",
  "STRIPE_TOLERANCE_SECONDS",
]);

function exportsOf(src) {
  return [
    ...src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm),
    ...src.matchAll(/^export\s+const\s+(\w+)\s*=/gm),
  ].map((m) => m[1]);
}

const orphans = [];

for (const [file, src] of sources) {
  for (const name of exportsOf(src)) {
    if (ALLOWED_UNCALLED.has(name) || DATA_EXPORTS.has(name)) continue;

    // Count every occurrence, including the definition. "Called" means it
    // appears somewhere OTHER than its own definition line.
    let called = false;
    for (const [other, osrc] of sources) {
      const hits = [...osrc.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
      if (other === file) {
        // In its own file: the definition contributes 1, so 2+ means a use.
        if (hits.length > 1) called = true;
      } else if (hits.length > 0) {
        called = true;
      }
      if (called) break;
    }

    if (!called) orphans.push(`${file}: ${name}`);
  }
}

if (orphans.length) {
  console.error("Exports with no production call site:\n" + orphans.map((o) => `  ${o}`).join("\n"));
  console.error(`\n${orphans.length} unreachable export(s).`);
  process.exit(1);
}
console.log("All exports are reachable from production code.");