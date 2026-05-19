# Verify step: fall back to nohup PID check when systemd user bus is unavailable

## What changed

`setup/verify.ts` now probes whether `systemctl --user` can actually reach a dbus session before trusting the systemd code path. When the bus is unreachable, verify falls through to the nohup PID-file check (`nanoclaw.pid` at the project root), matching the install-time fallback in `setup/service.ts`.

Two new helpers were extracted in `setup/verify.ts`:

- `hasUserSystemdBus()` — runs `systemctl --user is-system-running` and returns `false` only when stderr contains `Failed to connect to bus`. Non-zero exits from "degraded"/"starting" states are still treated as a working bus.
- `checkNohupPid(projectRoot, setter)` — reads `nanoclaw.pid`, verifies the PID is alive via `process.kill(pid, 0)`, and sets `service` / `runningFromPath` via callback.

The systemd branch's guard is now `mgr === 'systemd' && (isRoot() || hasUserSystemdBus())`. After that branch runs, if `service` is still `not_found`, the nohup check runs as a final fallback.

## Why

On this VPS (Ubuntu 24.04 in a container-like environment), `/proc/1/comm` is `systemd`, so `hasSystemd()` returns `true` and `getServiceManager()` returns `'systemd'`. But there is no per-user dbus — `systemctl --user` fails with `Failed to connect to bus: No medium found`.

`setup/service.ts` already handles this correctly: it tries `systemctl --user daemon-reload` and, on failure, writes the `start-nanoclaw.sh` nohup wrapper and records `FALLBACK: wsl_no_systemd`. But `verify.ts` blindly tried `systemctl --user is-active <unit>` and `list-unit-files`, both of which fail silently with the same bus error, leaving `service = 'not_found'`. The healthy nohup process (PID recorded in `nanoclaw.pid`) was never checked.

Net result before the fix: a healthy install reported `SERVICE: not_found` and `STATUS: failed`, exiting non-zero.

## Files touched

- `setup/verify.ts:71` — guarded the systemd branch with `hasUserSystemdBus()`; added nohup fallthrough at the end of the branch.
- `setup/verify.ts:100` — replaced inline PID-file check in the `else` branch with a call to `checkNohupPid()`.
- `setup/verify.ts:283` — added `hasUserSystemdBus()` helper.
- `setup/verify.ts:300` — added `checkNohupPid()` helper.

No test changes required — `setup/verify.test.ts` only exercises `determineVerifyStatus`, which is unaffected. All 369 tests still pass.

## How to verify

```bash
pnpm run build
pnpm exec tsx setup/index.ts --step verify
```

Expected on a host running via the nohup wrapper:

```
SERVICE: running
STATUS: success
```

To confirm the install is actually healthy independent of the verify check:

```bash
ps -p $(cat nanoclaw.pid) -o pid,etime,cmd   # process alive
tail -n 20 logs/nanoclaw.log                 # "NanoClaw running" + recent activity
```
