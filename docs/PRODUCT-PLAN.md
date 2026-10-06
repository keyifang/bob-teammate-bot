# Bob AI — Product Plan

Role: Product Manager. Every claim below is either verified by a command I ran,
or explicitly marked unverified. Evidence is quoted.

---

## 1. What I verified before planning

| Check | Result |
|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` exists | Yes — 1M ctx, tools supported |
| `openrouter/free` exists | Yes — 200k ctx, tools supported |
| Both answer a basic question | Yes — 2.2s and 1.9s (vs 40–130s today) |
| `openrouter/free` is a router | Confirmed: served by `cohere/north-mini-code:free`, and `nemotron-3-nano-omni-30b` on another call |
| `nemotron-3-ultra` tool chain | **BROKEN** — see below |
| `openrouter/free` tool chain | Works, but inconsistent (see below) |
| Telegram bot→bot messages | **IMPOSSIBLE** — official FAQ |
| Bots per BotFather account | 20 (40 with Premium) |
| Bots per group | 20 |

---

## 2. Three findings that change the plan

### 2.1 Requirement 8 cannot be built as described

From the official Telegram Bot FAQ, quoted in `node-telegram-bot-api`
discussion #1089:

> "Bots talking to each other could potentially get stuck in unwelcome loops. To
> avoid this, we decided that **bots will not be able to see messages from other
> bots regardless of mode**."

So "the bots can also reply to … the other bots" is **not implementable** on
the Bot API. Two bots in one group cannot hear each other, ever, in any mode.

This is not a workaround-able limitation. It is a server-side rule designed to
prevent bot loops.

**What I recommend instead** — an **orchestrated relay**, where one bot is the
visible speaker and the others are consulted server-side:

- The **relay bot** is the only bot with an active webhook in that chat.
- The relay receives the human message, asks the other bots' backends (our
  own service, in parallel, by *name*), and either posts their replies or
  summarises the disagreement.
- Bot-to-bot becomes a **server-side fan-out**, not a Telegram feature.

This preserves the user experience you described — multiple named personas
debating, each with its own memory — without fighting the platform. It also
turns the limitation into the moat: it takes a relay architecture to do this,
which a single-bot competitor cannot replicate overnight.

**Decision needed from you:** relay (recommended) or drop bot-to-bot.

### 2.2 Requirement 1's model cannot use tools

`nemotron-3-ultra-550b-a55b:free` advertises `tools` support, and does emit a
tool call — but as **plain text**, not as a structured call:

```
"<tool_call>\n<function=web_fetch>\n<parameter=url>\nhttps://www.engadget.com/gaming/..."
```

Reproduced twice. `finish_reason: stop`, 221 chars of markup.

Left alone, Bob would post that literal `<tool_call>` markup into your group.

So: **it can be a Bob, but not a Bob with research.** Two options:

- **(a) Keep it, disable tools for it.** Fast (2.2s), reliable for
  conversation and for answering from memory. No live facts.
- **(b) Keep tools, add a text-tool-call parser.** We already parse tool calls;
  extend the parser to recognise this markup. ~2 days, and fragile — it is a
  model bug we would be compensating for.

**Recommendation:** ship it as **"Bob Chat"** (option a) and keep the current
lightning model as **"Bob Research"**. Two personalities, two tiers of value —
and it maps neatly onto your pricing ladder.

### 2.3 "Get lucky" is real, and that is fine

`openrouter/free` served `cohere/north-mini-code:free` on one call and
`nemotron-3-nano-omni-30b:free` on another. Genuinely random. It produced a
correct, grounded answer from search results on the second try, and
malformed tool-call text on the first.

This is a viable **free tier**, with a caveat: it must be resilient to bad
output, which we already largely have — the reasoning-leak and degeneracy
guards exist precisely because free models misbehave.

---

## 3. Product shape

```
                    ┌──────────────────────────────────┐
                    │        Bob service (one)         │
   Telegram  ──────▶│  routes by chat + bot name       │
   webhook          │  per-bot memory, per-chat relay   │
                    └───────────────┬──────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        Supabase              OpenRouter            research
     (per-bot memory)        (2 model tiers)      (ddgs + fetch)
```

### Memory — the schema that earns the subscription

The insight in requirement 11 is right, and it is the whole product: **a bot's
memory is the asset, and it must never be shared.** Today the schema keys
everything on `chat_id`, which means one memory per chat. For per-bot memory
it must key on `(chat_id, bot_id)`.

New tables (additive, no migration of existing data):

```sql
users            -- unchanged, plus telegram_id, subscription fields
subscriptions    -- user_id, plan, bot_quota, status, stripe_customer_id
bots             -- bot_id, owner_user_id, telegram_user_id, telegram_token,
                 --   display_name, persona, model_tier, created_at
                 --   UNIQUE(telegram_user_id) -- one Telegram bot = one Bob
bot_chats        -- (bot_id, chat_id), enabled, relay_position, is_primary
                 --   PRIMARY KEY (bot_id, chat_id)
bot_messages     -- id, bot_id, chat_id, sender, text, created_at
                 --   the tier A raw window, now per bot
bot_summaries    -- bot_id, chat_id, tier_b_summary  -- per-bot rolling summary
bot_owner_memory -- bot_id, tier_c_summary           -- travels with the bot
bot_turns        -- bot_id, chat_id, turn_seq        -- relay orchestration
```

**Requirement 9** ("when the same bot is added to another group, it uses
context from previous chats") is served by keying `bot_owner_memory` on
`bot_id`, not `chat_id`. That is a one-line consequence of the schema, and it
falls out for free — but only if we design for it now.

**Requirement 10** (no cross-user mixing) is served by
`bot_owner_memory.bot_id → bots.owner_user_id`. Isolation by construction,
enforced by a foreign key rather than by remembering to filter.

### Requirement 8's context rule — a correction

> "bots should consolidate/summarize the context when it hit 20% context"

Today the trigger is a **message count** (40 stored). Changing to a percentage
of the model's context window is worse, not better:

- 20% of 1M tokens is 200k tokens — summarising that is enormously expensive
- 20% of 200k tokens (the `openrouter/free` tier) is 40k — also large
- the cost scales with the model, and the model is user-selectable

**Recommendation:** keep a count-based trigger as the primary signal, and add a
**token-count trigger as a second, independent** guard:
`min(40 messages, 15% of context_window)`. Message count bounds cost
deterministically; the token bound catches a chat with very long messages that
40 rows would never trigger. Cost stays predictable, and you get both
properties.

### The "20%" trigger, done properly

| Signal | Fires when | Why |
|---|---|---|
| Message count | 40 rows in tier A | predictable cost |
| Token count | 15% of the bot's context window | catches long messages |
| Never | both, then fold oldest into tier B | one summarisation pass |

Keep the existing property that has real value: **write the summary before
deleting the rows**, so a failure between the two is recoverable.

---

## 4. Requirements 3–5: teaching Bob to know what he doesn't know

This is the product's actual intelligence, and it is a **prompt + loop**
design, not a new model.

### 4.1 The core loop

```
message
  → classify: is this time-sensitive / factual / uncertain?
      no  → answer from context
      yes → search (web_search)
           → is the evidence sufficient?
                no  → fetch a source URL
                     → sufficient? no → say so, do not guess
                yes → answer, cite, caveat if thin
```

### 4.2 What to add

**(a) A freshness rule in the persona.** Today the persona says "use the
provided summary and recent messages to stay consistent". It does not say the
training data is stale. Add:

> Your training data has a cutoff. Anything that may have changed since then —
> prices, people in roles, versions, schedules, "current", "latest", "now" — is
> something to look up, not to recall. If you look it up and the sources
> disagree or are thin, say so plainly rather than picking the most confident
> answer.

**(b) An explicit sufficiency check.** After a search, before answering:

> Do the results actually answer the question? If they are off-topic, or only
> partially answer it, either fetch a source that would, or say "couldn't find
> a solid answer on X" — never fill the gap from memory.

**(c) Uncertainty markers in the persona.** Not a disclaimer on every message —
that would violate the "short and human" rule. Only when it earns its place:

> State a caveat only when it changes what the person should do. "Might be out
> of date" is worse than useless if you don't know what would be true.

**(d) `openrouter/free` needs the degenerate-output guards**, which we already
built for the reasoning models. Random models will occasionally emit tool-call
markup as text — the `nemotron-3-ultra` behaviour above is exactly what a
random model will do sometimes.

### 4.3 Requirement 4 — "users should probe for more"

This is the **progressive disclosure** pattern, and it is the single best
retention mechanic in the product:

- Bob's first answer: **short** (already enforced, measured 131–412 chars)
- Bob ends with a cheap invitation when it applies: *"want the current price?"*
- When the user probes, Bob researches **more deeply** — multiple searches,
  fetches the best sources, and gives a fuller answer with sources

This gives a visible "wow, it got better" moment on demand, which is what
converts a user to paid. It also directly maps to the two tiers: free tier gets
one search, paid gets research depth.

---

## 5. Monetisation — the pricing has a structural bug

Your plan: **$1 per bot.** Checked against reality:

| Constraint | Value | Effect on pricing |
|---|---|---|
| Bots per BotFather account | 20 (40 Premium) | Caps supply |
| Bots per group | 20 | Caps per-group fan-out |
| Telegram bots per user | Effectively unlimited groups | Demand unbounded |

**The problem:** at $1/bot, a user with 5 bots pays $5. But **all their bots run
on our compute and our OpenRouter key.** With reasoning models measured at
40–130s per reply, and 20 bots potentially active in one group, one heavy user
can cost multiples of what they pay.

Two fixes, and I'd do both:

### 5.1 Charge for capability, not just count

```
Free            $0    1 bot, 1 search per message, no fetch depth
Pro             $5/mo 5 bots, 5 searches + full research depth, unlimited memory
Pro+            $15/mo unlimited bots, priority model routing, relay debates
Add-on          $1/bot per month beyond the plan's included count
```

A flat $1/bot makes 1 bot and 20 bots feel like the same product; tiering makes
the *quality* of research the thing being bought, which is what actually costs
us money.

### 5.2 Enforce the economics in code

Per-bot-per-message **budget caps**, because a free model is a shared resource:

| Cap | Free | Pro |
|---|---|---|
| Searches per message | 1 | 5 |
| Total tool hops | 2 | 6 |
| Model tier | `openrouter/free` | user-selectable |

This is not just cost control — it is what stops bots from ping-ponging in a
group, which would burn quota and annoy the group.

### 5.3 Why the database is the product

Requirement 11 says memory must stay separate per bot, per user, across groups.
That is not a technical detail — **it is the switching cost.**

A user cannot leave Bob without losing the accumulated memory of every named bot
they built up, in every group. That is a genuinely defensible moat, and it only
exists if the schema keys memory per bot from day one. Retrofitting it after
launch means migrating live memory, which is the worst possible time to learn
that your key was wrong.

**Recommendation: do the schema change before writing a single line of the
multi-bot UI.** It is 2–3 days now. It is a migration and a data-loss risk later.

---

## 6. Deployment (requirement 7)

Today: local machine + a Cloudflare quick tunnel. Works, dies on reboot, URL
changes on restart.

| Concern | Local today | Target |
|---|---|---|
| Postgres | local, `bobdb` | Supabase pooled |
| App | local, port 3000 | Render (Docker) |
| Webhook URL | ephemeral tunnel | permanent Render hostname |
| Secrets | `.env` on disk | Render env vars |
| Cost | $0 | ~$0 on free tiers, $7 if Render needs paid |

Sequence that avoids a broken demo:

1. **Supabase project** — pooled URL, apply schema
2. **`render.yaml` with a real `DATABASE_URL`** — the config already exists
3. **Render Blueprint** — the repo is already pushed (`keyifang/bob-teammate-bot`)
4. **Register the webhook** against the Render hostname — `npm run register`
   already verifies via `getWebhookInfo`

**Blocker:** I need a live Supabase project. The two refs found in your other
Telegram projects (`zrhsrqwjdhtfdkhrlmkn`, `dxqrbxqcelsugqixhqkc`) both return
**NXDOMAIN** — deleted or paused. I will not invent credentials.

Keep local running for trials; that is explicitly fine and it is the right way
to iterate.

---

## 7. Build order

Sequenced so each step is independently shippable and testable.

| # | Phase | Why here | Est |
|---|---|---|---|
| 0 | **Schema: bot-scoped tables** | Everything multi-bot depends on it. Doing it later is a migration. | 2–3d |
| 1 | **Bot identity: model as per-bot config** | Removes `MODEL_NAME` global. Small, unblocks model choice. | 1d |
| 2 | **Two named tiers: Chat + Research** | Ships requirement 1&2 as user value now, on current schema | 2d |
| 3 | **Freshness + sufficiency persona** | Requirements 3–5. Pure prompt work, biggest perceived-intelligence win. | 1d |
| 4 | **Progressive probing** | Requirement 4. Cheap to add, drives conversion. | 1d |
| 5 | **Multi-bot in a chat (relay)** | Requirement 8. The hard one — needs 0. | 5–7d |
| 6 | **Per-bot memory isolation** | Requirements 9,10. Mostly schema; verifies the key. | 2d |
| 7 | **Subscriptions + quotas** | Requirement 11. Cannot bill before caps exist. | 4–6d |
| 8 | **Supabase + Render** | Requirement 7 | 1–2d |

Total ~4–5 weeks. Phases 0–4 are ~1 week and produce something genuinely
demoable and sellable.

---

## 8. What I recommend we do next

Three decisions I need from you, then I start on Phase 0:

1. **Bot-to-bot: relay or drop?** The platform forbids direct bot-to-bot.
   My recommendation is relay — it keeps your differentiator.
2. **Model tiers: is my split right?** Bob Chat (fast, no tools) vs Bob
   Research (tools, grounded) — or do you want every bot to keep tools?
3. **Pricing: accept tiering over flat $1/bot?** Flat per-bot pricing has a
   cost problem I cannot solve with the current free-model latency.

---

## 9. Honest unknowns

- **Multi-bot relay latency.** A 5-bot debate at ~5–20s per bot is the largest
  unverified risk in this plan. I have not measured it, and if it is slow the
  relay design needs rethinking. **This is the first thing I would measure
  after Phase 0.**
- **`openrouter/free` consistency.** Measured twice, correct once. Good enough
  for a free tier, not for a paid one.
- **Supabase connection under Render.** Never tested — no project exists.
- **Whether users pay for bots or for memory.** My belief is memory, because
  that is the switching cost. Untestable without users.