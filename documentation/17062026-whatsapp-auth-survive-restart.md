# WhatsApp auth survives clean shutdown (no re-pair on restart)

## What changed

Fixed the WhatsApp adapter's connection-close handler so a **clean shutdown no
longer deletes the saved session**. Previously every service restart/reboot
wiped `store/auth/` and forced a fresh pairing.

## Why (root cause)

`teardown()` sets `shuttingDown=true` and calls `sock.end()`, which fires a
`connection: 'close'` event with `reason=undefined`. The old handler computed:

```js
const shouldReconnect = !shuttingDown && reason !== DisconnectReason.loggedOut;
if (shouldReconnect) { /* reconnect */ }
else { /* "logged out" → fs.rmSync(authDir) */ }
```

During a clean shutdown `shouldReconnect` is `false`, so control fell into the
single `else` — which treated **any** non-reconnect close as a logout and
deleted `creds.json`. It conflated "not reconnecting" with "logged out." The
next boot then logged `Channel credentials missing, skipping channel=whatsapp`
and the number was unlinked.

This only bit on restarts where WhatsApp was *actively connected* (the adapter
had to be in `activeAdapters` for `teardown()` to fire), which is why first-time
activation worked but every subsequent restart/reboot wiped the link.

## The fix

Split the non-reconnect path: clear creds **only** on a genuine
`DisconnectReason.loggedOut`; otherwise (clean shutdown or any other non-logout
close) preserve auth.

```js
const loggedOut = reason === DisconnectReason.loggedOut;
const shouldReconnect = !shuttingDown && !loggedOut;
if (shouldReconnect)      { /* reconnect */ }
else if (loggedOut)       { /* clear creds — real logout only */ }
else                      { /* preserve auth, log "auth preserved" */ }
```

## Files touched

- `src/channels/whatsapp.ts` — the `connection.update` `'close'` branch: add
  `const loggedOut`, gate the credential wipe behind `else if (loggedOut)`, and
  add a final `else` that preserves auth and logs
  `WhatsApp connection closed without logout — auth preserved`.

## How to verify

```bash
# 1. Link WhatsApp (pairing code or QR) → creds present
ls store/auth/creds.json

# 2. Restart with WhatsApp connected
sudo systemctl restart nanoclaw

# 3. Logs: clean teardown preserves auth, new boot reconnects
grep -E 'auth preserved|auth cleared|Connected to WhatsApp' logs/nanoclaw.log | tail
#   want: "WhatsApp connection closed without logout — auth preserved"
#   then: "Connected to WhatsApp"   (NOT "auth cleared")

# 4. Creds still there
ls store/auth/creds.json   # present
```
