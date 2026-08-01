# GBA MMO — Browser Client (GB-Link USB)

Replaces the original Raspberry Pi proxy: the page multiboots the game to the
GBA through a GB-Link USB adapter and relays gameplay traffic to the server
over WebSocket. The GBA ROM is unmodified — the adapter's GB mode driven with
4-byte chunks is electrically identical to the Pi's 32-bit SPI.

## Requirements

- GB-Link USB adapter, unified firmware v2.2.x+
- **GBC-type link cable.** The link only uses SC, SI and SO (SD is untouched),
  but a GBA OEM cable's wiring grounds the adapter's receive pin, so GBA
  cables cannot work.
- Chrome/Edge (WebUSB) or Firefox 151+ (WebSerial)
- Node.js for the server

## Quick start (local)

```
cd server && npm install
node index.mjs
```

Open http://localhost:8081/ (localhost is a secure context, so WebUSB works).
The WebSocket listens on 8080 and the web client on 8081 (`PORT` /
`PORT_WEB` env vars); pages served over plain http default the Server field
to `ws://<host>:8080`, everything else to the production server.

Accounts live in `server/.node-persist/`; the world resets on server restart
but accounts/skills/bank persist.

## Production hosting

- **Frontend** — https://gbammo.gblink.io: deploy the contents of `web/`
  as-is (static, no build step; include `data/gba-mmo_mb.gba`). The baked-in
  default server is `wss://gbammoserver.gblink.io`
  (`PRODUCTION_SERVER_URL` in `src/ui/AppUI.js`).
- **Backend** — gbammoserver.gblink.io: `node server/index.mjs`, reachable as
  wss — the HTTPS page cannot connect to plain ws.

## Playing

1. **Connect USB** — adapter powers the link at 3.3 V.
2. **Create Account** (once per server). There are no passwords: the server
   hands out a bearer token, stored in the browser's localStorage keyed by
   server URL, and *Start Game* logs in with it automatically. The optional
   email is stored but never read by any code — it only lets the server
   operator manually find an account if a token is lost. The token is the
   whole credential, so anyone holding it controls the character. *Show*
   reveals it for copying to another device, *Use Token* saves a pasted one
   (that is the login form), *Forget* only unlinks this browser — the
   account stays on the server, but without its token it is unreachable.
   Character names are not unique and are never used to look up accounts.
3. **Send Multiboot** with the GBA off, then turn the GBA on (hold nothing).
   The ROM streams in a few seconds.
4. **Start Game**. The GBA shows CONNECTING, receives the first update, then
   waits **5 more seconds by design** (a startup hack in the original ROM —
   not a hang) before the town appears.

**Game Already Loaded** skips multiboot when the game is still running from a
previous Start/Stop in this page session. If the adapter was replugged or the
page reloaded, prefer re-multibooting: entering GB mode glitches the clock
line once, which can permanently desync an already-running game.

Stop / server disconnects / eviction (logging in elsewhere) leave the GBA
running — Start Game reconnects without re-multibooting. After ~60 s with no
input the server logs you out (original behavior); reconnect the same way.

## Tuning

- **Word gap (µs)** — pause the adapter inserts after each 32-bit word,
  giving the GBA's serial ISR time to keep up. Default 100 µs
  (hardware-verified clean down to 36 µs, ~3× margin); a worst-case update
  burst takes ~35 ms. If the stats line shows rising `junk` or updates stop
  taking effect, raise it — 1000 µs is exact Raspberry Pi parity and always
  safe.
- **Idle polling** — clocks a few idle words between server ticks so button
  presses reach the server sooner (~200 ms faster). On by default (50 ms);
  turn it off for strict Pi-parity debugging.

## Hardware verification script

Town: talk to the mayor (A to advance dialogue). Take the east teleporters:
Lumber Ridge → lumberjack gives a HATCHET → chop a tree (wood + XP toast);
fisher gives a ROD → fish at the fishing spot. Var Rock → miner gives a
PICKAXE → mine. Back in town: bank chest deposit/withdraw; finish the mayor's
Wood+Rock quest for 1000 coins; check the START menu pages. Two players: a
second adapter+GBA in another browser profile/machine must see the first
player move, and logging in with the same token elsewhere must evict the
first session.

## Rebuilding the ROM

```
export DEVKITPRO=/opt/devkitpro DEVKITARM=/opt/devkitpro/devkitARM
make && cp gba-mmo_mb.gba web/data/
```

The page logs a build fingerprint after loading the ROM. The GBA runs the
last-multibooted image — after rebuilding, Send Multiboot again.

## Troubleshooting

- **Multiboot never detects the GBA (0x6202 poll)** — wrong cable (must be
  GBC-type), GBA already past the BIOS (power-cycle), or a unit that needs
  the firmware's `CONFIG_GB_LINK_DRIVE_SD_LOW` build option.
- **"GBA link not responding" mid-game** — cable disturbed or game desynced:
  power-cycle the GBA and Send Multiboot again.
- **Login failed** — token belongs to a different server/database. Forget
  the token and create a new account.
