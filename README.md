# Bob — AI teammate for Telegram group chats

Bob is a persistent AI teammate that lives in Telegram group chats. It holds
context across days and across the chats a person owns, reaches beyond its
training data through two tools, and renders tables, checklists and lists
natively in Telegram.

Bob always says it is an AI. That is a hard requirement, not a style setting —
see [AI disclosure](#ai-disclosure).

## What Bob is for

A personal assistant, a helpful colleague, and a friend you add to a group chat
for **chatting, assistance, discussion, brainstorming, ideation, planning and
drafting proposals**.

Weather was a test case, not the product. The capabilities that matter are the
conversational ones: holding a thread across turns, asking the clarifying
question that actually changes the answer, pushing back, and producing a
structured artefact when asked for one.

### Multi-persona inside one bot

A group can hold several named bots — `/addbot Alice`, `/addbot Bob` — and they
discuss with each other, with the human able to interject at any point.

This is forced by Telegram, not a design choice. Verified in the official Bot API
FAQ: *"bots will not be able to see messages from other bots regardless of
mode."* Real bot-to-bot conversation is impossible. So the personas live **inside
one bot**, which is the only arrangement that works, and each is routed by name.

### Verified against five real users

`scripts/persona-test.mjs` drives the real prompt assembly and the real model.

| Persona | Need | Result |
|---|---|---|
| Sam, solo founder | decides fast, wants the number and the risk | answers the 80k question with the actual cost categories |
| Priya, parent | cares about the kids, not the itinerary | heat, thunderstorms, school holidays |
| Alex, engineer | wants the actual error, not reassurance | unclosed streams and socket handling |
| Maya, writer | needs a real artefact | 4,691-char proposal: summary, phases, budget |
| Dev, chatter | quick facts, will not wait | 20°C, clear, 15km/h wind |

5/5 on-topic, with routing correct: proposals and plans take the stronger model,
everything else the fast one.

## Layout

| File | Role |
|---|---|
| `server.js` | Webhook server, model calls, triggering, orchestration |
| `config.js` | Persona and summariser prompts, AI-disclosure guarantee |
| `db.js` | Postgres access; schema bootstrap |
| `prompt.js` | Assembly of the reply prompt (tiers C, B, A) |
| `bots.js` | Named-bot routing: who answers, and what text the model sees |
| `model-config.js` | Which model generates a given reply (per-bot tier, else default) |
| `relay.js` | Relay sequencing: fan-out cap, discussion context, cancellation |
| `quota.js` | Plans and per-message caps (search budget, tool hops) |
| `document.js` | HTML export rendering, incl. escaping |
| `memory.js` | What Bob remembers about a user, and what it refuses to |
| `router.js` | Task routing: which model answers a chat vs a draft |
| `speak.js` | Whether Bob joins a group conversation, or stays out |
| `export.js` | Format registry (pdf/html/markdown/text/csv/docx/xlsx/zip) |
| `pdf.js` | Runs `pdf_export.py` (ReportLab) |
| `pdf_export.py` | PDF generation; transliterates non-Latin-1 characters |
| `payment.js` | Stripe checkout, signature verification, purchase switch |
| `credits.js` | Micro-dollar ledger arithmetic |
| `storage.js` | Cloudflare R2 project storage (optional, S3 via SigV4) |
| `session-window.js` | Memory window, summarisation triggers, cache-stable order |
| `providers.js` | Provider and model registry (OpenRouter, opencode go) |
| `commands.js` | Slash commands and inline keyboards |
| `tools.js` | `owl_research`, `web_search`, `web_fetch`, incl. the SSRF guard |
| `formatting.js` | Markdown → Telegram HTML, and chunking |
| `register-webhook.js` | One-shot `setWebhook` + verification |
| `schema.sql` | Reference schema (the app applies the same DDL on boot) |

## Named bots and the relay

A group can host several named bots. Naming one — `@Alice`, `Alice,`, or
`Alice:` — routes the message to that bot, which answers as its own persona
with its own memory (`bot_messages` keyed on `bot_id`) and its own model tier.

Naming several at once starts a **relay turn**: they answer in sequence, each
seeing what the earlier ones said, so the group gets a discussion rather than N
unrelated replies. Two properties make this work:

- **The turn is not awaited in the webhook handler.** The handler runs one job
  per chat in order; awaiting the turn would hold the queue for its whole
  duration and a human's interjection would sit behind it, unable to cancel
  anything.
- **Cancellation is checked before each bot**, so an interjection during the
  first bot's generation stops the rest rather than racing them.

The relay is the only bot holding a Telegram token. Named bots are personas
consulted server-side, which is why `bots.telegram_user_id` is nullable.

## Memory isolation

Memory is keyed on `(bot_id, chat_id)`, not on `chat_id` alone, and two
properties fall out of the key rather than a filtering convention:

- a bot carries what it learned in one group into the next, because
  `bot_owner_memory` is keyed on `bot_id` alone
- two owners' bots never mix, because `bot_id → owner_user_id` is a foreign key

## Model routing, and why it exists

Bob is two different jobs. Chatting in a group is latency-sensitive — the
experience *is* the speed — while researching or drafting can wait and wants a
stronger model.

Measured, four calls each on the same conversational prompt:

```
nvidia/nemotron-3.5-lightning:free       5.0s 1.4s 3.0s 4.8s   4/4 ok
nvidia/nemotron-3-ultra-550b-a55b:free  6.4s 13.3s 0.4s 2.8s   3/4 ok
```

Lightning is both faster *and* more reliable on the free tier, so it leads for
chat and research; the reasoning model is reserved for drafts. A group aside
answers in ~4s.

The classifier is a regex, not a model call. Roughly half of all calls to a
saturated free tier fail, so an extra classification per message is a
reliability cost spent on a decision the regex gets right. `"just chat"` from the
person beats any heuristic.

## When Bob speaks

The old rule was a question mark plus a cooldown, so he interjected on any
question to anyone. Now he speaks when **addressed**, or when the question is
squarely his domain.

The cooldown governs **volunteering, not being spoken to**. Someone who names
Bob twice in a minute is waiting, and ignoring the second message reads as
broken.

## The humanizer is opt-in

It was a second model call per reply, purely to adjust tone. Measured on a reply
the main model had already written correctly:

```
usable=2   narrated=4   empty=0
```

It narrates its reasoning two runs in three, and the persona **already**
specifies the register it was being asked to add — short, no preamble, casual,
contractions. On a half-saturated tier it was a second chance to fail.

Set `HUMANIZE=true` to restore it; `HUMANIZE_DEFAULT_OFF=false` forces it on.

## Plans and quotas

A plan bounds capability as well as bot count, because every bot runs on our
compute and our model key.

| Plan | Bots | Searches / message | Tool hops | Model choice |
|---|---|---|---|---|
| free | 1 | 1 | 2 | no |
| pro | 5 | 5 | 6 | yes |
| pro_plus | unlimited | 10 | 8 | yes |

A missing subscription is the normal free case, never an error. An **inactive**
subscription also resolves to free — reading `plan='pro'` off a canceled row
would grant paid capability to a non-paying user. A bot runs on its **owner's**
plan, not the sender's, so a guest cannot spend someone else's quota.

### Credit purchase

Purchases can be turned off for free testing with one environment variable,
without removing the integration:

```bash
CREDIT_PURCHASES_ENABLED=false   # off: the pack button explains and nothing is charged
CREDIT_PURCHASES_ENABLED=true    # or unset it entirely, to sell
```

It **defaults to on** — only an explicit `false`, `0`, `no` or `off` disables it,
so a typo can never silently stop charging real customers. The switch covers
the webhook as well as the button, so a checkout started before it was flipped
does not deliver credit after it.

### Payment status: SANDBOX

The configured Stripe keys are **test-mode** (`sk_test_…`, `livemode: false`),
verified against the live API. Purchases currently test cards only:
`4242 4242 4242 4242`.

**Before taking real money, the live key is required:** replace
`STRIPE_SECRET_KEY` with an `sk_live_…` key, and note that a live webhook
endpoint has its own `whsec_…` signing secret, which is **different** from the
test one. Creating a live Checkout Session also means the `success_url` must
point somewhere real.

Two constraints found by calling the API, both of which fail silently otherwise:

- inline `price_data` requires a `tax_code`, or every session is refused with
  *"the product tax code is missing"*;
- the webhook must be given the `x-stripe-signature` header over the **exact**
  bytes sent, so the route is excluded from the JSON body parser — re-serialising
  the parsed object changes the bytes and every event fails verification.

Credit is granted only from a signature-verified, idempotent webhook. The browser
redirect never grants anything, because that would let anyone mint credit by
visiting a URL.

## Document export

`/export [format] [title]` sends the last answer as a document. Formats:
**pdf** (default), `html`, `markdown`, `text`, `csv`, `docx`, `xlsx`, `zip`.

PDF is generated by `pdf_export.py` using ReportLab, which is pure Python with no
system libraries — so it works on Render and Vercel, where WeasyPrint's
Pango/cairo/GTK chain does not. Where Python is genuinely absent the export
falls back to HTML rather than failing.

`docx` and `xlsx` are real OOXML: ZIP archives of XML parts written with
`node:zlib`, so no dependency is added. The `zip` format packages a stored
project (`/save_project`, retrieved with `/project_zip`).

The reply body is always escaped and never interpreted as markup — a reply
containing `</html>` or a `<script>` tag cannot alter or truncate the document.
Project paths are checked too, because a path from a chat message is
attacker-influenced and a traversal would escape the archive.

## Memory

### What you told Bob

A fact, not a summary. Told *"my partner Sam is vegetarian and I'm allergic to
peanuts"*, then asked *"what should we order for dinner?"* in **another group**,
Bob answers from it.

Facts are keyed on the **user**, not the chat — you are the same person in every
group. A summary is regenerated by a model call that can blur any of it; a row
cannot. Credentials, card numbers and bank details are refused outright, and a
correction retracts a stale fact while keeping the history of what was believed.

Only the **link** to a third party is kept. Storing *"Sam (my partner) is
vegetarian"* beside *"I'm allergic to peanuts"* produced *"considering Sam's diet
and peanut allergy"* — a claim that SAM is allergic. That is a factual
assertion about a real person's health, so it must not survive.

### Chat history

Three tiers, assembled broadest-first into every reply prompt.

| Tier | Scope | Contents | Updated |
|---|---|---|---|
| A | one bot, one chat | last 10 messages, verbatim | every message |
| B | one bot, one chat | rolling summary of everything older | above 30 stored messages, **or** 15% of the context window |
| C | one bot, all its chats | rolling summary across every chat that bot is in | with tier B |

Two independent summarisation triggers: a message **count** bounds cost
deterministically, and a **token estimate** catches a chat of a few very long
messages that never reaches a row count but still blows the context budget. The
size trigger prunes harder, because folding in one huge message at a time never
converges — it would still be over budget after being summarised.

When a chat crosses the threshold the oldest messages are folded into tier B
and the raw rows are deleted. The summary is written **before** the rows are
deleted, so a failure between the two leaves the text recoverable and retries
on the next trigger rather than losing it.

Tier C is written only for the chat's owner. A collaborator inside someone
else's chat never has their own cross-chat memory updated by it.

Every read is scoped by `chat_id`, so one chat's contents cannot reach
another's prompt.

## Ownership

A chat's owner is the person who added Bob, recorded once and never reassigned.
A private chat has no invite event, so the first person to message it becomes
the owner. Because ownership is immutable, a chat keeps drawing on its
creator's context even if that person later leaves — this is intended.

## Reply triggering

Bob replies when mentioned, when replied to, and always in a private chat.
In groups it also occasionally joins in unprompted, subject to a 45s cooldown
and a per-chat queue that ensures at most one in-flight reply per chat.

## Formatting

`formatting.js` escapes all text before inserting any markup, so a message
containing `<`, `>` or `&` renders literally instead of breaking the send.
Tables become aligned monospaced blocks, checklists keep visible checkboxes,
and a reply over 4096 characters is split at line boundaries with any tag that
spans the boundary closed and reopened, so each message is valid HTML on its
own. If Telegram still rejects the markup, the reply is re-sent as escaped
plain text rather than being lost.

## AI disclosure

`ensureAiDisclosure()` in `config.js` checks Bob's introduction for a
self-identification and appends one if the model omitted it. The joining
message and the first message of a private chat both pass through it, so the
disclosure does not depend on the model complying.

## Running

```bash
npm install
cp .env.example .env      # fill in the values
npm start                 # applies the schema, then listens on PORT
npm run register          # register the webhook + verify getWebhookInfo
```

The schema is applied on boot, so an empty database is enough — there is no
separate migration step. `ensureSchema()` is idempotent, so restarting is safe.

Telegram requires a public HTTPS URL for the webhook. Create the bot with
BotFather, and disable privacy mode so Bob can read all group messages.

### Local Postgres

```bash
createdb bobdb
```

`DATABASE_URL` in `.env` points at it. The app also works unchanged against
Supabase or any managed Postgres; see [Deployment](#deployment).

## Tests

```bash
npm test                                     # unit + formatting + SSRF guard
BOB_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/bobdb_test npm test
```

`BOB_TEST_DATABASE_URL` enables the integration and end-to-end suites. They
**drop and recreate** that database, so point it at a throwaway one.

The end-to-end suite spawns the real `server.js`, talks to a real Postgres, and
drives it with real HTTP webhook POSTs. Only Telegram and the model provider are
stubbed, via `TELEGRAM_API_BASE` and `MODEL_API_URL`.

## Model provider

Any OpenAI-compatible `chat/completions` endpoint works. The variables are
deliberately provider-agnostic (`MODEL_API_KEY`, `MODEL_API_URL`, `MODEL_NAME`),
so switching from OpenRouter to anything else is a `.env` edit.

The default is a **free reasoning model** (`nvidia/nemotron-3.5-lightning:free`),
which has two consequences worth knowing:

- **Reasoning is billed as completion tokens.** A six-character reply used 194
  of 203 completion tokens. `max_tokens` must therefore be far above the visible
  answer length, or the reply arrives empty while the log looks healthy. The
  budgets live in `REPLY_MAX_TOKENS` and `SUMMARY_MAX_TOKENS`.
- **Latency is well above the PRD's targets.** A plain reply was measured at
  ~4s and a tool-calling turn at ~66s, against targets of 6s and 30s. The
  request timeout is 180s so long turns are not cut off mid-flight, and the
  typing indicator is kept alive throughout, but a user waiting on a fetch will
  wait. Switching to a non-reasoning model is the fix if that matters more than
  cost.

Usage is logged per call, with reasoning tokens broken out and OpenRouter's
reported `cost` when present.


Notable coverage:

- the HTML balance checker is itself negative-controlled — known-bad input must
  be reported bad, or the chunking assertions would pass vacuously
- 20 SSRF cases are asserted to be refused, including decimal- and hex-encoded
  loopback, IPv4-mapped IPv6, and a hostname that resolves to loopback
- cross-chat isolation is asserted on the prompt actually sent to the model
- the AI-disclosure tests use a stub that deliberately omits the disclosure, so
  they prove the app enforces it rather than the model
- `schema.sql` is executed against a real Postgres rather than compared by
  inspection, because a hand-maintained mirror drifts and a name-only check
  would not catch a file that does not run
- the deployment checks read `render.yaml` as JSON, so a syntax error fails
  locally instead of at deploy time

## Deployment

`render.yaml` and `Dockerfile` deploy the bot to Render as a Docker service,
matching the shape used by the sibling `leadgen` and `signalboost` services.
Push to GitHub, then in Render: **New → Blueprint** and point it at the repo.
Every secret is `sync: false`, so Render prompts for each one and nothing
sensitive lives in the repository.

Fill in at deploy time:

| Variable | Notes |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `MODEL_API_KEY` | OpenRouter key |
| `DATABASE_URL` | Supabase pooled URL or any Postgres |
| `WEBHOOK_SECRET` | same value the running service uses |
| `OWL_API_URL`, `OWL_API_KEY` | optional; unset disables `owl_research` |

`WEBHOOK_URL` is deliberately not in `render.yaml`: it only exists once Render
has assigned a hostname. Add it, then run `npm run register` locally with the
same `.env` to point Telegram at the live service.

`register-webhook.js` calls `setWebhook`, then `getWebhookInfo`, and fails
non-zero if Telegram reports `last_error_message` — a webhook that registers
but silently fails is otherwise indistinguishable from a healthy one until you
read that field. It refuses to run with a non-HTTPS URL, a secret shorter than
16 characters, or a placeholder secret.

### Supabase

Use the **pooled** connection string (port 5432, user `postgres.<ref>`), not
the direct one. Two reasons:

- the pooler sits in front of a small number of server connections, so
  `PGPOOL_MAX` defaults to 5 rather than pg's default
- `ensureSchema()` issues one statement per query, because the pooler's
  transaction mode rejects a multi-statement string

Paste the pooled URL as `DATABASE_URL`. Nothing else changes; the schema is
applied on first boot.

## Environment

See `.env.example`. Missing required variables abort the process at boot with a
named error, rather than starting half-configured.

`.env` is read by `env.js`, which `server.js` imports **before** anything that
reads `process.env` while being loaded. ES module imports are evaluated before
the importing module's own body, so calling `dotenv.config()` inline in
`server.js` would run too late and the database URL would be ignored.
`db.js` also builds its pool lazily, so the ordering cannot be broken by
accident.

`HOST` is not configurable — bind behind a reverse proxy if you need to restrict
the listening interface.

## Deployment status

Live at **https://bob-teammate-bot.onrender.com**, serving the **pooled Supabase**
database. The Telegram webhook is registered with `pending_update_count: 0` and no
`last_error_message`.

| Piece | State |
|---|---|
| Render service | live, free plan (sleeps when idle; first message after a gap takes ~30-60s to wake) |
| Database | Supabase pooled, 6543, verified - schema applies, writes work, and `claimUpdate` returns exactly one winner from five concurrent calls |
| Telegram webhook | registered, `allowed_updates: ["message", "callback_query"]` |
| Stripe | **sandbox**; purchases currently **disabled** for free testing |
| opencode go | verified: requires `x-opencode-session`, reports `reasoning_content`, all three models accept tools |
| Cloudflare R2 | not configured; `/save_project` says so plainly. Optional and off the critical path |

Two deployment bugs worth remembering, because both looked correct while being
wrong:

- `setWebhook` with `allowed_updates: ["message"]` succeeds silently and then
  **every inline button does nothing**, because Telegram never delivers the
  press. `callback_query` must be listed.
- the `/stripe-webhook` route must be excluded from the JSON body parser: the
  signature is computed over the exact bytes Stripe sent, and re-serialising the
  parsed object invalidates it.

### Still to do

1. **Live Stripe keys** before taking real money — see Payment status above.
2. **Re-enable purchases** by unsetting `CREDIT_PURCHASES_ENABLED` when ready to
   sell.
3. **First real message.** No automated test has driven a live Telegram message
   through the deployed service; that needs a human in a chat.
