# Bob — AI teammate for Telegram group chats

Bob is a persistent AI teammate that lives in Telegram group chats. It holds
context across days and across the chats a person owns, reaches beyond its
training data through two tools, and renders tables, checklists and lists
natively in Telegram.

Bob always says it is an AI. That is a hard requirement, not a style setting —
see [AI disclosure](#ai-disclosure).

## Layout

| File | Role |
|---|---|
| `server.js` | Webhook server, model calls, triggering, orchestration |
| `config.js` | Persona and summariser prompts, AI-disclosure guarantee |
| `db.js` | Postgres access; schema bootstrap |
| `prompt.js` | Assembly of the reply prompt (tiers C, B, A) |
| `tools.js` | `owl_research` and `web_fetch`, incl. the SSRF guard |
| `formatting.js` | Markdown → Telegram HTML, and chunking |
| `register-webhook.js` | One-shot `setWebhook` + verification |
| `schema.sql` | Reference schema (the app applies the same DDL on boot) |

## Memory model

Three tiers, assembled broadest-first into every reply prompt.

| Tier | Scope | Contents | Updated |
|---|---|---|---|
| A | one chat | last 20 messages, verbatim | every message |
| B | one chat | rolling summary of everything older | above 40 stored messages |
| C | one owner | rolling summary across all that owner's chats | with tier B, owner only |

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

## Outstanding setup

1. **Privacy mode must be disabled.** `@bob_friendly_ai_bot` is currently
   `can_read_all_group_messages: false`, i.e. Telegram only forwards messages
   that mention Bob or reply to him. That breaks FR-03 (every message
   persisted), tier A/B memory, TC-15 (unprompted restraint) and TC-07
   (summarisation trigger), because the older messages are never delivered.
   Fix in BotFather: `/setprivacy` → Disable.

2. **GitHub repo.** The code is committed locally but not pushed; no GitHub
   token is available in this environment, and SSH can push but cannot create
   a repository.

3. **`WEBHOOK_URL` must be a public HTTPS URL**, then run `npm run register`.
   Telegram refuses plain HTTP, so a local run needs a tunnel.
