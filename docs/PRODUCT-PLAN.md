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

### 2.2 Requirement 1's model — corrected

**I got this wrong in the first draft of this plan, and the correction matters.**

I originally wrote that `nemotron-3-ultra-550b-a55b:free` "emits tool calls as
literal text". Sampling 8 runs says otherwise:

```
SUMMARY of 8: structured=3  textToolCall=0  plain=0  empty=5
```

**It emits properly structured tool calls. The text-emission I saw came from
`openrouter/free`**, which routed to a different model on that call — not from
nemotron-ultra. I attributed a random router's behaviour to a named model.

The 5 "empty" results were not the model failing to emit a call. The raw
response explains them:

```
{"error":{"message":"Upstream error from Nvidia: Service temporarily overloaded",
          "code":503,"metadata":{"error_type":"provider_overloaded"}}}
```

So the real constraint is **not** "this model can't use tools". It is:

> **The free tier drops roughly 60% of requests with a 503 "provider
> overloaded".** A tool-using turn is 2+ requests, so the chance of at least
> one 503 on a research question is high.

This is a *retry* problem, not a capability problem — which is the good news.
The existing code already retries degenerate output; it does not yet retry 503s.

**Actions:**
1. Retry 503 / `provider_overloaded` with backoff (3 attempts, jittered)
2. Count consecutive 503s; after N, surface "the free model is overloaded, try
   again" rather than failing silently
3. Track success rate per model in the log, so tier choice is evidence-based

Verified: `openrouter/free` produced a clean structured call in the same test
(`finish_reason: tool_calls`, valid arguments, with reasoning in the proper
field).

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

## 7. Agreed decisions (2026-10-07)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Relay orchestration** — bots discuss server-side; user addresses them by name | Bot API forbids bot-to-bot. A relay keeps the UX and the moat. |
| 2 | **Every bot keeps tools**, on `nemotron-3-ultra-550b-a55b:free` for the POC | Free tiers will improve; correctness of the tools layer matters more than speed now. |
| 3 | **$1/bot/month** stays | Cost floor collapses as free models improve. Caps still needed as abuse protection. |
| 4 | **HTML/PDF export** from a group message | New capability; see 7.2. |

### 7.1 Relay design (decision 1)

User-facing shape:

```
KY: @alice what do you think? @bob disagree?
  → relay: alice and bob discuss server-side (user sees "Alice and Bob are
    thinking..." with a live indicator)
  → one consolidated message posts to the group, attributed per paragraph
  → user can interject at any time; the interjection is folded into the
    in-flight relay turn
```

Implementation consequences:

- **A relay turn is not a Telegram message.** It is our own orchestration
  record, so we control latency and can stream progress.
- **Chim-in must not be blocked.** The relay keeps reading the chat while the
  bots discuss; a new human message cancels or redirects the turn.
- **Long tail is the UX risk.** N bots × slow free model = minutes. Mitigation:
  publish a partial answer as soon as the first bot answers, then append.
  Do not wait for consensus.
- **Cost multiplies with N.** Cap relay fan-out at 3 bots for the POC.

### 7.2 HTML/PDF export (decision 4)

Telegram can deliver a document. `sendDocument` accepts bytes, so no public
host is required.

```
bot renders answer → HTML → weasyprint/playwright → PDF
                  → upload to Telegram → post as a document
```

**Unverified:** I have not tested HTML→PDF on this machine. It needs either a
headless Chromium (~150MB — the same dependency `ddgs` in Node avoided) or
`weasyprint` (Python, lighter). **Recommendation: generate a styled HTML
document first** (no dependency, useful on its own, readable on a phone), and
add PDF only once the HTML path is proven and someone actually asks for it.

---

## 8. Build order

Sequenced so each phase ships independently. Phases 0-4 are the demoable POC.

| # | Phase | Ships | Est |
|---|---|---|---|
| **0** | **503/overload retry with backoff** | Unblocks the chosen free model. Without it ~60% of requests die. | 0.5d |
| **1** | **Bot-scoped schema** | `bots`, `bot_chats`, `bot_messages`, `bot_summaries`, `bot_owner_memory` | 2-3d |
| **2** | **Per-bot model config** | Removes the `MODEL_NAME` global; each bot picks its own tier | 1d |
| **3** | **Named bots in a chat** | `/addbot name`; a bot answers when called by name | 2d |
| **4** | **Freshness + sufficiency persona** | Requirements 3-5. Pure prompt work, biggest perceived win | 1d |
| **5** | **Relay orchestration** | Bots discuss server-side; one consolidated post; user can interject | 5-7d |
| **6** | **Per-bot memory isolation** | Requirements 9,10 — verifies the Phase 1 key | 2d |
| **7** | **HTML document export** | Decision 4, HTML only first | 2d |
| **8** | **Subscriptions + quotas** | Decision 3, $1/bot with caps as abuse protection | 4-6d |
| **9** | **Supabase + Render** | Requirement 7 | 1-2d |

**Phase 0 first because it is a day of work that unblocks everything else.** At a
~60% failure rate the POC is not demoable, and no other phase can be verified
without reliable model calls.

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