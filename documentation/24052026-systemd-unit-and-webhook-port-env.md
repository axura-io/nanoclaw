# Systemd unit + WEBHOOK_PORT env loader

## What changed

Two small things, in response to "nanoclaw stopped responding after the May 21 reboot":

1. **System-wide systemd unit installed** at `/etc/systemd/system/nanoclaw.service`, enabled at boot. Runs `pnpm start` as the `nanoclaw` user from `/home/nanoclaw/nanoclaw`, with `EnvironmentFile=/home/nanoclaw/nanoclaw/.env` (so `WEBHOOK_PORT` and friends reach the process), appends to the existing `logs/nanoclaw.{log,error.log}`, and restarts on failure. Replaces the previous user-systemd path which never worked on this VPS — `systemctl --user` fails with `Failed to connect to bus: No medium found`, so the install-time `setup/service.ts` fallback path never produced a working unit and the host had no autostart at all.

2. **`src/webhook-server.ts` now reads `WEBHOOK_PORT` from `.env` directly** via the existing `readEnvFile` helper, with the same `process.env.X || envConfig.X || default` precedence used in `src/config.ts`.

## Why

Two independent failures, found in this order while investigating the outage:

**Autostart**: after the 2026-05-21 reboot, nanoclaw was simply not running and nothing would bring it back. No systemd unit on disk, `systemctl --user` non-functional, no crontab, no LaunchAgent. The host had silently been a manual-start install since whenever the user-systemd path last broke. A reboot took it down permanently.

**Env loader**: once the systemd unit was installed, the first attempt at `pnpm start` crashed with `EADDRINUSE: 0.0.0.0:3000` — port 3000 is owned by the Dokploy container on this box. Despite `WEBHOOK_PORT=3003` being in `.env` for months, the value was never reaching the process: `webhook-server.ts` only consulted `process.env.WEBHOOK_PORT`, and the codebase deliberately does **not** load `.env` into `process.env` (see the comment in `src/env.ts` — keeps secrets out of child-process environments). `pnpm start` doesn't load `.env` either. So a bare `pnpm start` from a shell silently fell back to port 3000 and crashed. The systemd unit got around this with `EnvironmentFile=`, but anyone running the host manually for debugging would hit the same crash. Source fix removes the footgun for both paths.

## Files touched

- `src/webhook-server.ts:14-17` — import `readEnvFile`, read `WEBHOOK_PORT` at module load.
- `src/webhook-server.ts:83` — `port` resolution now falls back to `envConfig.WEBHOOK_PORT` between `process.env.WEBHOOK_PORT` and `DEFAULT_PORT`.
- `/etc/systemd/system/nanoclaw.service` (new, not in the repo) — see contents below.

```ini
[Unit]
Description=NanoClaw host
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=nanoclaw
Group=nanoclaw
WorkingDirectory=/home/nanoclaw/nanoclaw
Environment=NODE_ENV=production
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/home/nanoclaw/nanoclaw/.env
ExecStart=/usr/bin/pnpm start
Restart=on-failure
RestartSec=5
StandardOutput=append:/home/nanoclaw/nanoclaw/logs/nanoclaw.log
StandardError=append:/home/nanoclaw/nanoclaw/logs/nanoclaw.error.log
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

The agent container image (`nanoclaw-agent-v2-16111809:latest`) was also missing entirely on this host and got rebuilt via `./container/build.sh`. That's a one-shot side-effect of the investigation, not a code change.

## How to verify

```bash
pnpm run build
sudo systemctl restart nanoclaw
sudo systemctl is-active nanoclaw                   # active
ss -tlnp | grep :3003                               # node listening
```

Verify the env-loader fix independently (bare run with no inherited env):

```bash
sudo systemctl stop nanoclaw
env -i HOME=/home/nanoclaw PATH=/usr/local/bin:/usr/bin:/bin node dist/index.js
# Expect: "Webhook server started port=3003 ..." — NOT EADDRINUSE on 3000.
# Ctrl-C, then:
sudo systemctl start nanoclaw
```

Reboot test (the original failure mode):

```bash
sudo reboot
# After it comes back:
systemctl is-active nanoclaw                        # active
tail -n 5 /home/nanoclaw/nanoclaw/logs/nanoclaw.log # "NanoClaw running"
```
