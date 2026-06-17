# Programmatic outbound: token-gated `POST /invoke`

## What changed

Added an HTTP endpoint, `POST /invoke`, that lets an external service push a
message straight to a channel adapter (WhatsApp today) **without going through
the agent**. Built for a scheduler that sends one-way birthday / reminder
messages.

- **`src/webhook-server.ts`** — new `/invoke` route on the existing shared
  webhook HTTP server (the same server that serves Chat SDK adapter webhooks,
  bound to `0.0.0.0:WEBHOOK_PORT`, `3003` on this host). Token-gated via an
  `X-Invoke-Token` header, constant-time compared against `INVOKE_TOKEN` from
  `.env`. Body `{ "jid", "text", "channel"? }` (`channel` defaults to
  `whatsapp`). Resolves the adapter via `getChannelAdapter(channel)` and calls
  `deliver(jid, null, { kind: 'text', content: { text } })`.
  - Responses: `200 {messageId}` sent · `202 {queued:true}` adapter queued it
    (e.g. WhatsApp socket momentarily down — flushes on reconnect) ·
    `400` missing/invalid body · `401` bad/missing token · `503` endpoint
    disabled (no `INVOKE_TOKEN`) or channel adapter not active · `502` delivery
    threw.
  - New exports: `ensureWebhookServer()`, `isInvokeEnabled()`.
- **`src/index.ts`** — starts the webhook server at boot when `INVOKE_TOKEN` is
  set (`isInvokeEnabled()` → `ensureWebhookServer()`), and stops it on shutdown.
  Required because native adapters (WhatsApp) don't register a Chat SDK webhook,
  so the server's lazy-start (via `registerWebhookAdapter`) never fires on a
  WhatsApp-only install.

Opt-in: with no `INVOKE_TOKEN` in `.env`, `/invoke` returns `503` and — on a
native-only install — the server isn't started at all.

## Why

The goal was **one-way, programmatic outbound**: an external cron/service
detects an event (a member's birthday) and tells NanoClaw to send a WhatsApp
message. The agent path (`routeInbound`) would require the target chat to be
wired to an agent and the sender to pass the access gate, plus an LLM call per
message. A direct push to the adapter is deterministic, free, and reuses the
adapter's outgoing queue + reconnect resilience (`whatsapp.ts` `sendRawMessage`).

The route is bolted onto the existing webhook server rather than a new listener
so there's a single HTTP surface/port to manage (`WEBHOOK_PORT=3003`, see
`24052026-systemd-unit-and-webhook-port-env.md`).

## Files touched

- `src/webhook-server.ts` — `crypto` + `getChannelAdapter` imports;
  `INVOKE_TOKEN` added to the module-load `readEnvFile`; `/invoke` branch at the
  top of the request handler inside `ensureServer()`; `handleInvoke()`,
  `ensureWebhookServer()`, `isInvokeEnabled()`, and the `sendJson` / `tokensMatch`
  helpers.
- `src/index.ts` — import of `ensureWebhookServer` / `isInvokeEnabled` /
  `stopWebhookServer`; boot block (step 3b) that starts the server when invoke is
  enabled; `stopWebhookServer()` added to the shutdown path.
- `.env` (gitignored) — `INVOKE_TOKEN=<secret>` (generate with
  `openssl rand -hex 24`).

## Security notes

- The shared webhook server binds to `0.0.0.0:WEBHOOK_PORT`. `/invoke` can send
  arbitrary messages to arbitrary recipients, so the `X-Invoke-Token` header is
  the security boundary (constant-time compared via `crypto.timingSafeEqual`).
  If the caller is off-box, firewall the port to that source as defense in
  depth; if on-box, call `127.0.0.1:3003`.
- The token lives only in `.env` (gitignored). Never commit it.

## How to verify

```bash
pnpm run build
sudo systemctl restart nanoclaw

# Health/auth: valid token + empty body → 400 (proves token + routing work)
curl -s -X POST http://127.0.0.1:3003/invoke \
  -H "X-Invoke-Token: $INVOKE_TOKEN" -H 'Content-Type: application/json' -d '{}'
# → {"ok":false,"error":"missing required field: jid"}

# Bad/missing token → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3003/invoke \
  -H 'Content-Type: application/json' -d '{"jid":"x","text":"y"}'   # 401

# Real send (WhatsApp must be linked + connected)
curl -s -X POST http://127.0.0.1:3003/invoke \
  -H "X-Invoke-Token: $INVOKE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jid":"<digits>@s.whatsapp.net","text":"hello"}'
# → 200 {"ok":true,"messageId":"...","channel":"whatsapp"}
```
