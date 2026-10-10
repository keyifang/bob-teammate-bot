// Persona testing: five real users, five different needs, one bot.
//
// Each persona encodes what a person of that kind ACTUALLY asks for, in the
// words they would use - not a test-case abstraction. The point is to see where
// Bob's responses break for a real person, not to assert that a function
// returns a string.
//
//   node scripts/persona-test.mjs
//
// It drives the real prompt assembly and the real model, so what it reports is
// what a user would see.

import "../env.js";
import { orderForCache } from "../session-window.js";
import { PERSONA_SYSTEM_PROMPT } from "../config.js";
import { TOOL_SCHEMAS, executeTool } from "../tools.js";
import { classifyTask } from "../router.js";
import { canHelp } from "../speak.js";
import { extractFacts } from "../memory.js";

const MODELS = {
  chat: "nvidia/nemotron-3.5-lightning:free",
  draft: "nvidia/nemotron-3-ultra-550b-a55b:free",
};

export const PERSONAS = [
  {
    id: "founder",
    name: "Sam, solo founder",
    needs: "decides fast, wants the number and the risk",
    turns: [
      "we're launching a coffee kiosk in march, budget 80k. should we do it?",
    ],
    good: /80k|launch|foot traffic|lease|margin/i,
  },
  {
    id: "parent",
    name: "Priya, parent planning a trip",
    needs: "cares about the kids, not the itinerary",
    turns: [
      "taking two kids to singapore in july, what should we actually plan around?",
    ],
    good: /kid|child|swim|attraction|heat|rain|july/i,
  },
  {
    id: "engineer",
    name: "Alex, engineer debugging",
    needs: "wants the actual error, not reassurance",
    turns: [
      "our node app is leaking file descriptors after 20 minutes under load. where do i look?",
    ],
    good: /descriptor|ulimit|file|open|leak|limit/i,
  },
  {
    id: "writer",
    name: "Maya, drafting a proposal",
    needs: "needs a real artefact, structured",
    turns: [
      "draft a proposal for a design studio partnering with Acme Corp. 8 weeks, AUD 40k fixed.",
    ],
    good: /scope|phase|week|deliver|timeline|40k/i,
  },
  {
    id: "chatter",
    name: "Dev, group chatter",
    needs: "quick factual answers, will not wait",
    turns: [
      "what's the weather in melbourne right now?",
    ],
    good: /\d+\s*°?c|cloud|rain|wind|sunny/i,
  },
];

async function oneCall(model, messages) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(process.env.MODEL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MODEL_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: 2000 }),
        signal: AbortSignal.timeout(150000),
      });
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content && content.trim()) return content.trim();
    } catch {
      /* overloaded */
    }
    await new Promise((r) => setTimeout(r, 1500 + attempt * 1200));
  }
  return null;
}

async function withTools(model, system, turns, facts = []) {
  const messages = [{ role: "system", content: system }];
  for (const t of turns) {
    messages.push({ role: "user", content: t });
    let out = null;
    for (let hop = 0; hop < 3; hop++) {
      const res = await fetch(process.env.MODEL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MODEL_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOL_SCHEMAS,
          tool_choice: hop === 2 ? "none" : "auto",
          max_tokens: 2000,
        }),
        signal: AbortSignal.timeout(150000),
      });
      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      if (data.error || !msg) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (msg.tool_calls?.length) {
        messages.push(msg);
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
          messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: String(result).slice(0, 6000),
          });
        }
        continue;
      }
      out = (msg.content || "").trim();
      break;
    }
    if (!out) return { reply: "(no reply)", tools: 0 };
    messages.push({ role: "assistant", content: out });
  }
  return { reply: messages[messages.length - 1].content, messages };
}

export async function runPersona(p, { facts = [] } = {}) {
  const task = classifyTask(p.turns[0]);
  const model = MODELS[task] ?? MODELS.chat;

  const factBlock = facts.length
    ? "What you know about them:\n" + facts.map((f) => `- ${f}`).join("\n")
    : "";

  const system = orderForCache({
    persona: PERSONA_SYSTEM_PROMPT,
    ownerSummary: factBlock,
    sessionSummary: "",
    turns: p.turns.map((t) => `User: ${t}`).join("\n"),
    latest: `User: ${p.turns[p.turns.length - 1]}`,
  });

  const { reply, messages } = await withTools(model, system, p.turns);
  const usedTools = (messages ?? []).filter((m) => m.role === "tool").length;

  return {
    id: p.id,
    name: p.name,
    task,
    model,
    reply,
    usedTools,
    volunteers: canHelp({ text: p.turns[0], addressed: false }),
    onTopic: p.good.test(reply),
    len: reply.length,
  };
}

// Run directly: prints a table, so failures are visible rather than counted.
//
// Compared on the FILENAME alone. The full path never matches on Windows: the
// file URL is percent-encoded ("%20" for spaces) while process.argv[1] is not,
// so an endsWith on the whole path silently skipped every run - the script
// exited 0 having done nothing.
// process.argv[1] may be RELATIVE ("scripts/x.mjs") while import.meta.url is
// absolute, percent-encoded, and slash-separated - so comparing paths never
// matches. The FILE NAME is the only part guaranteed to be identical.
const invokedDirectly = process.argv[1]
  ? import.meta.url.endsWith(process.argv[1].split(/[/\\]/).pop())
  : false;

if (invokedDirectly) {
  const results = [];
  for (const p of PERSONAS) {
    process.stdout.write(`\n${p.name} (${p.needs})\n  asks: "${p.turns[0]}"\n`);
    const r = await runPersona(p);
    console.log(`  task=${r.task} model=${r.model.split("/").pop()} tools=${r.usedTools} len=${r.len}`);
    console.log(`  on-topic: ${r.onTopic ? "yes" : "NO"}`);
    console.log(`  reply: ${r.reply.slice(0, 280).replace(/\n/g, " ")}`);
    results.push(r);
  }
  const bad = results.filter((r) => !r.onTopic || r.reply === "(no reply)");
  console.log(`\n${results.length - bad.length}/${results.length} on-topic`);
  if (bad.length) {
    console.log("FAILED:", bad.map((b) => `${b.id} (${b.task})`).join(", "));
  }
}
