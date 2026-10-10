// Per-bot personality.
//
// A group can hold several named bots and the relay lets them discuss - but
// every bot was built from the SAME system prompt with only a different
// display_name, and the `bots.persona` column was never read at all. So "Alice"
// and "Bob" were the same person with two labels, and a discussion between them
// was one voice answering twice.
//
// What makes a second bot worth having is a different JUDGEMENT, not a
// different name: someone who pushes back, someone who checks assumptions,
// someone who is practical. Those are the presets below.

import { PERSONA_SYSTEM_PROMPT } from "./config.js";

// Presets a user picks from with /persona <bot> <trait>. Each is a stance,
// not a mannerism - a stance is what makes a discussion worth having.
export const TRAITS = {
  strategist: "a blunt strategist who pushes back, cuts the padding, and says what the evidence actually supports",
  analyst: "a careful analyst who checks assumptions and flags what is uncertain instead of guessing",
  builder: "a practical builder who cares about what actually gets done this week rather than theory",
  challenger: "a constructive challenger who actively looks for the flaw in the plan and says so kindly",
  explainer: "a patient explainer who makes complicated things simple without padding them out",
};

// A description is user text placed inside the system prompt, so it is untrusted
// input: bounded, and framed so it cannot read as an override.
const MAX_DESCRIPTION = 400;

/**
 * The system prompt for one bot: the shared register, plus this bot's own
 * character.
 *
 * Deterministic by construction - the persona sits in the CACHED prefix, so a
 * non-deterministic build would defeat prompt caching entirely.
 */
export function personaSystemPrompt(bot) {
  const name = String(bot?.display_name ?? "Bob").trim() || "Bob";
  const raw = String(bot?.persona ?? "").trim();

  // Bounded, so a pasted wall of text cannot crowd out the rules.
  let description = raw.slice(0, MAX_DESCRIPTION);
  if (raw.length > MAX_DESCRIPTION) description = description.trimEnd() + "...";
  if (description) {
    // A newline would start a new section and read as fresh instructions.
    description = description.replace(/[\r\n]+/g, " ").trim();
  }

  // With no description there is nothing to describe, so the sentence is
  // omitted entirely. "described as: ." reads as a broken prompt and invites the
  // model to invent a character instead of using the shared one.
  const identity = description
    ? `You are ${name}, an AI teammate in this group chat, described as: ${description}.` +
      ` That description shapes your JUDGEMENT - what you prioritise and how you` +
      ` push back - not your honesty: you are still an AI, and you say so when asked.`
    : `You are ${name}, an AI teammate in this group chat.`;

  // The shared persona is a template literal that begins with a blank line, so
  // trimming is what keeps the join to exactly one blank line instead of three.
  // A stray newline run is small, but it is sent on every single call.
  return `${identity}\n\n${PERSONA_SYSTEM_PROMPT.trim()}`;
}

export function describeTraits() {
  return Object.entries(TRAITS).map(([id, text]) => `${id} - ${text}`);
}

/** Resolves a trait name, or a free description, to what gets stored. */
export function resolvePersona(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Give a trait name or a short description." };
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  if (TRAITS[key]) return { ok: true, persona: TRAITS[key], trait: key };
  // Anything else is accepted as a free description, bounded.
  return { ok: true, persona: raw.slice(0, MAX_DESCRIPTION), trait: null };
}
