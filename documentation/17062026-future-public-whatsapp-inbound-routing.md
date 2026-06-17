# Future improvement: public inbound routing for WhatsApp (open customer line)

**Status:** Deferred — *not implemented*. Captured 2026-06-17 to revisit later.
Today WhatsApp is **outbound-only** (see `17062026-invoke-endpoint.md`); no agent
is wired to inbound WhatsApp messages.

## Goal

Let *any* WhatsApp user message the bot's number and get an automatic reply from
a designated agent (the **CPB Customer Agent**, `ag-1779249472452-1hzs2d`) — a
public customer-service line with zero per-sender approval. Also: switch CPB's
customer-facing channel from Telegram to WhatsApp (keep or drop the owner's
Telegram DM — TBD).

## Why it isn't a one-flag change

Each WhatsApp **DM is its own messaging group**, keyed by the *sender's* JID.
When a new sender messages the bot, `routeInbound` auto-creates their group with
`unknown_sender_policy='request_approval'` and **no wiring** (`src/router.ts`
auto-create branch) → the message escalates to the owner for approval, never
answered. Flipping `public` on existing rows does nothing for the *next* new
sender.

The access model has three layers (all must allow):

1. messaging-group `unknown_sender_policy`: `strict | request_approval | public`
   — checked first in the access gate (`src/modules/permissions/index.ts`). Only
   `public` skips the known-user check.
2. wiring `sender_scope`: `all | known` — `known` overrides even a public group.
3. members / roles allowlist (`agent_group_members` + `user_roles`).

Note: the existing CPB→Telegram wiring is already `sender_scope=all`, yet only
the owner can use it — because the Telegram group's policy is `request_approval`
and the access gate runs before the scope gate. So `public` on the group is the
real requirement.

## Proposed implementation (Path A)

1. **Config** — new `.env` key `PUBLIC_CHANNEL_AGENTS` mapping channel→agent,
   e.g. `whatsapp:ag-1779249472452-1hzs2d`. Parse in `src/config.ts`; expose
   `getPublicChannelAgent(channelType)`.
2. **Router** (`src/router.ts`) — after resolving `mg` / `agentCount`, before the
   `agentCount===0` escalation branch: if the channel has a configured public
   agent and the group is unwired and not `denied_at`, set
   `unknown_sender_policy='public'` (`updateMessagingGroup`) and create a wiring
   via `createMessagingGroupAgent` (which also auto-creates the
   `agent_destinations` row so outbound is allowed). Mirror the working CPB
   wiring: `engage_mode='pattern'`, `engage_pattern='.'`, `sender_scope='all'`,
   `ignored_message_policy='drop'`, `session_mode='shared'`, `priority=0`. Then
   continue to fan-out so the message is answered immediately.
   - `session_mode='shared'` (NOT `agent-shared`) keeps each customer in their
     own session → no cross-talk between customers.
3. **Clean replies** — `ASSISTANT_HAS_OWN_NUMBER=true` (already set) so outbound
   carries no `Andy:` prefix.
4. **Channel switch** — decide whether to remove the owner's
   `telegram:706872931 → CPB` wiring (full switch) or keep it (owner retains a
   private Telegram line to CPB).

## Risks / open items

- **Public exposure**: anyone with the number can talk to CPB and spend tokens.
  CPB is locked down (`cli_scope=disabled`, no shell/admin — see the guardrail
  mock test in `mock_test.md`); keep it that way before exposing it.
- **No rate-limiting today** — add abuse / rate controls before going live.
- The one already-created customer DM group (currently `request_approval` and
  unwired) would be auto-wired on its next inbound message under Path A.

## How to verify (once implemented)

Message the bot from a **non-owner** WhatsApp number; confirm in
`logs/nanoclaw.log` the public-channel auto-wire line, then a CPB reply delivered
back to that DM.
