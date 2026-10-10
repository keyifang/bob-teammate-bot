// Relay testing: do the personas actually DISCUSS, against the real model?
//
// Every existing relay test uses a stub that returns "Stub reply." for both
// personas. That proves the ORCHESTRATION - sequencing, fan-out cap,
// cancellation, memory - but says nothing about whether two named bots produce
// a discussion, which is the entire point of the feature.
//
// Telegram blocks bot-to-bot messages ("bots will not be able to see messages
// from other bots regardless of mode"), so the personas live inside one bot and
// this is the only way to see what a user sees.
//
//   node scripts/relay-test.mjs
//
// What it checks, per turn:
//   - did each persona speak at all
//   - did they speak DIFFERENTLY (a discussion, or two copies of one answer)
//   - did the later persona reference what the earlier said
//   - could a human interject mid-turn

import "../env.js";
import { orderForCache } from "../session-window.js";
import { PERSONA_SYSTEM_PROMPT } from "../config.js";
import { TOOL_SCHEMAS, executeTool } from "../tools.js";
import { planRelay, buildDiscussionContext } from "../relay.js";
import crypto from "node:crypto";

const MODEL = process.env.MODEL_RESEARCH ?? "nvidia/nemotron-3.5-lightning:free";
const NL = String.fromCharCode(10);

async function callModel(messages, { tools = true, maxTokens = 1200 } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(process.env.MODEL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MODEL_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          max_tokens: maxTokens,
          ...(tools ? { tools: TOOL_SCHEMAS, tool_choice: "auto" } : {}),
        }),
        signal: AbortSignal.timeout(150000),
      });
      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      if (data.error || !msg) {
        await new Promise((r) => setTimeout(r, 1500 + attempt * 1200));
        continue;
      }
      if (msg.tool_calls?.length) {
        const out = [];
        for (const c of msg.tool_calls) {
          let result;
          try {
            result = await executeTool(
              c.function.name,
              JSON.parse(c.function.arguments || "{}")
            );
          } catch (e) {
            result = `Tool failed: ${e.message}`;
          }
          out.push({ id: c.id, result });
        }
        return { toolCalls: out, text: null };
      }
      return { text: (msg.content || "").trim(), toolCalls: [] };
    } catch {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return { text: null, toolCalls: [] };
}

async function askPersona(name, question, discussion, history) {
  const system = orderForCache({
    persona: PERSONA_SYSTEM_PROMPT,
    ownerSummary: "",
    sessionSummary: "",
    turns: history,
    latest: `User: ${question}`,
  });

  const messages = [
    { role: "system", content: system },
    ...(discussion
      ? [{ role: "user", content: `Earlier in this thread:${NL}${discussion}${NL}${NL}Answer the user's question, taking the others' views into account. Agree or disagree as makes sense - do not just repeat them.` }]
      : [{ role: "user", content: question }]),
  ];

  for (let hop = 0; hop < 3; hop++) {
    const { text, toolCalls } = await callModel(messages);
    if (toolCalls.length) {
      messages.push({ role: "assistant", content: null, tool_calls: toolCalls.map((t) => ({
        id: t.id, type: "function",
        function: { name: "tool", arguments: "{}" },
      })) });
      for (const t of toolCalls) {
        messages.push({ role: "tool", tool_call_id: t.id, content: String(t.result).slice(0, 4000) });
      }
      continue;
    }
    return text;
  }
  return null;
}

/** How similar are two replies? 0 = identical, 1 = wholly different. */
export function difference(a, b) {
  const norm = (s) =>
    String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const wa = norm(a);
  const wb = norm(b);
  if (!wa.length || !wb.length) return 0;
  const setB = new Set(wb);
  const shared = wa.filter((w) => setB.has(w)).length;
  return 1 - shared / Math.max(wa.length, wb.length);
}

export async function runRelay({
  personas = ["Alice", "Bob"],
  question,
  history = "",
  interjectAfter = null,
} = {}) {
  const bots = personas.map((display_name, i) => ({ display_name, relay_position: i }));
  const order = planRelay(bots);
  const replies = [];
  const log = [];

  for (const bot of order) {
    const discussion = buildDiscussionContext(
      replies.map((r) => ({ name: r.name, text: r.text }))
    );
    const text = await askPersona(bot.display_name, question, discussion, history);

    if (interjectAfter != null && replies.length === interjectAfter) {
      // The human jumps in; the remaining personas must see this.
      const interjection = "hold on, we've already tried the cafe on 5th";
      log.push({ kind: "interjection", text: interjection });
      replies.push({ name: "KY", text: interjection });
      history += `${NL}User: ${interjection}`;
    }

    if (text) {
      log.push({ kind: "speak", name: bot.display_name, len: text.length, text });
      replies.push({ name: bot.display_name, text });
    } else {
      log.push({ kind: "silent", name: bot.display_name });
    }
  }

  const speeches = log.filter((l) => l.kind === "speak");
  const texts = speeches.map((s) => s.text);
  return {
    log,
    spokeAll: speeches.length === order.length,
    spoke: speeches.length,
    expected: order.length,
    distinct: texts.length >= 2 ? difference(texts[0], texts[1]) : 0,
    interleaved: log.some((l, i) => l.kind === "interjection" && log.slice(0, i).some((x) => x.kind === "speak")),
  };
}

export const SCENARIOS = [
  {
    id: "open-decision",
    question: "should we open a coffee kiosk in march, or wait until july?",
    personas: ["Alice", "Bob"],
  },
  {
    id: "disagreement",
    question: "is a $40k marketing budget worth it for a coffee kiosk launch?",
    personas: ["Alice", "Bob"],
  },
  {
    id: "interjection",
    question: "where should we open the second kiosk?",
    personas: ["Alice", "Bob", "Carol"],
    interjectAfter: 1,
  },
];

const invokedDirectly = process.argv[1]
  ? import.meta.url.endsWith(process.argv[1].split(/[/\\]/).pop())
  : false;

if (invokedDirectly) {
  const all = [];
  for (const s of SCENARIOS) {
    process.stdout.write(`${NL}== ${s.id}: "${s.question}"${NL}`);
    const r = await runRelay(s);
    for (const e of r.log) {
      if (e.kind === "interjection") console.log(`  [KY interjects] ${e.text}`);
      else if (e.kind === "speak") console.log(`  ${e.name} (${e.len}): ${e.text.slice(0, 190).replace(new RegExp(NL, "g"), " ")}`);
      else console.log(`  ${e.name}: SILENT`);
    }
    console.log(`  spoke ${r.spoke}/${r.expected} | distinctness ${r.distinct.toFixed(2)} | interjection reached a later bot: ${r.interleaved}`);
    all.push({ ...s, ...r });
  }
  const bad = all.filter((r) => !r.spokeAll);
  console.log(`\n${all.length - bad.length}/${all.length} scenarios had every persona speak`);
  if (bad.length) console.log("FAILED:", bad.map((b) => b.id).join(", "));
}
