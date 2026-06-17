# NanoClaw Cheatsheet

A quick reference for operating NanoClaw. For deeper context, see [CLAUDE.md](CLAUDE.md) and `docs/`.

## Service Control

```bash
# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw

# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Dev mode (hot reload)
pnpm run dev
```

## Logs

```bash
tail -f logs/nanoclaw.error.log   # errors first
tail -f logs/nanoclaw.log         # full routing chain
ls logs/setup-steps/              # per-step setup logs
```

Container logs are lost on exit (`--rm`). Check session DBs instead.

## Admin CLI (`ncl`)

```bash
ncl help                          # top-level help
ncl <resource> help               # per-resource help

# Agent groups
ncl groups list
ncl groups get <id>
ncl groups create --name "..." --personality "..."
ncl groups update <id> --personality "..."
ncl groups restart --id <id> [--rebuild] [--message "..."]
ncl groups config get --id <id>
ncl groups config update --id <id> --model claude-opus-4-7
ncl groups config add-mcp-server --id <id> ...
ncl groups config add-package --id <id> <pkg>

# Messaging groups (one chat on one platform)
ncl messaging-groups list
ncl messaging-groups create --channel telegram --chat-id ...

# Wirings (messaging group ↔ agent group)
ncl wirings list
ncl wirings create --messaging-group <id> --agent-group <id>

# Users & roles
ncl users list
ncl roles list
ncl roles grant --user <id> --role admin [--agent-group <id>]
ncl roles revoke --user <id> --role admin

# Members (unprivileged access gate)
ncl members add --agent-group <id> --user <id>
ncl members remove --agent-group <id> --user <id>

# Destinations
ncl destinations list --agent-group <id>
ncl destinations add --agent-group <id> --channel ... --target ...

# Read-only
ncl sessions list
ncl user-dms list
ncl dropped-messages list
ncl approvals list
```

## Session Inspection

Sessions live at `data/v2-sessions/<agent-group>/<session>/`:
- `inbound.db` — host writes, container reads (`messages_in`)
- `outbound.db` — container writes, host reads (`messages_out`)

Ad-hoc SQL (use this — NOT the `sqlite3` CLI):

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select id, name from agent_groups"
pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<sid>/inbound.db  "select * from messages_in order by seq desc limit 5"
pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<sid>/outbound.db "select * from messages_out order by seq desc limit 5"
```

## Common Slash Skills

Run from inside Claude Code:

| Skill | Use For |
|-------|---------|
| `/setup` | First-time install |
| `/init-first-agent` | Bootstrap a DM-wired agent |
| `/manage-channels` | Wire channels ↔ agent groups |
| `/customize` | Add channels, integrations, behavior changes |
| `/debug` | Troubleshooting |
| `/update-nanoclaw` | Pull upstream into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault, migrate `.env` |
| `/add-telegram`, `/add-slack`, `/add-discord`, ... | Add a channel |
| `/add-opencode`, `/add-codex`, `/add-ollama-provider` | Swap agent provider |
| `/add-gmail-tool`, `/add-gcal-tool` | Add MCP tools |
| `/migrate-from-v1` | Finish a v2 migration |
| `/claw` | Install the `claw` CLI |

## Build & Test

```bash
# Host (Node + pnpm)
pnpm run build
pnpm test

# Container image (Bun)
./container/build.sh

# Force clean container rebuild (cache is sticky)
docker builder prune -af && ./container/build.sh

# Agent-runner deps (separate package — use bun, not pnpm)
cd container/agent-runner && bun install
cd container/agent-runner && bun test
cd container/agent-runner && bun run typecheck
```

## OneCLI (Credentials)

```bash
onecli --help
onecli agents list
onecli agents secrets --id <agent-id>
onecli agents set-secret-mode --id <agent-id> --mode all       # inject all matching vault secrets
onecli agents set-secrets --id <agent-id> --secret-ids <a>,<b> # selective
onecli secrets list
```

Web UI: <http://127.0.0.1:10254>

**Gotcha:** auto-created agents start in `selective` mode — no secrets attached. Flip to `mode all` if API calls return 401 despite the credential being in the vault.

## Troubleshooting Quick Path

1. `tail logs/nanoclaw.error.log` — errors?
2. `ncl sessions list` — does the session exist?
3. Inspect `inbound.db` — did the message reach the container?
4. Inspect `outbound.db` — did the agent respond?
5. `ncl approvals list` — anything stuck pending?
6. `onecli agents secrets --id <id>` — credentials attached?
7. `ncl groups restart --id <id>` — kick the container.

## Key Paths

| Path | What |
|------|------|
| `data/v2.db` | Central DB (users, groups, wiring, roles) |
| `data/v2-sessions/` | Per-session inbound/outbound DBs |
| `groups/<folder>/` | Per-agent-group filesystem (CLAUDE.md, skills, overlay) |
| `src/` | Host code |
| `container/agent-runner/src/` | Agent-runner (Bun) |
| `container/skills/` | Skills mounted into every container |
| `logs/` | Host + setup logs |
| `documentation/` | Dated change notes for this install |
