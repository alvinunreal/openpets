---
description: Explore the experimental OpenPets LAN mode for multi-machine pet visits, authenticated server/client setup, topology hints, and packaging validation.
---

# LAN mode

This experimental mode makes one OpenPets default pet shared across PCs on a LAN.
Only the current owner machine shows the pet. Dragging the pet to a screen edge
hands ownership to the next/previous connected host.

## Experimental multi-pet foundation

The coordinator state can also represent one independently traveling pet per
connected host. Each record keeps the pet's owner host, selected pet ID, current
host, and latest position. This foundation allows two pets to occupy the same
host while preserving the existing single-pet fields and behavior.
Pet IDs are normalized at registration, and clearing a host's selection removes
its coordinator record. Every edge-crossing attempt consumes its arm; returning
a pet to its owner after host loss also requires a fresh move away from the edge
before another handoff.

Meeting interactions, privacy-preserving MCP work signals, and Control Center
setup are intentionally deferred to later phases of
[issue #93](https://github.com/alvinunreal/openpets/issues/93). Multi-machine GUI
validation is pending while the second test system is unavailable, so this work
remains experimental.

### Experimental visiting-pet rendering

Set `OPENPETS_LAN_PETS=multi` on every participating host to exercise the next
experimental phase. Each host registers its selected default pet. When that pet
migrates away, its default window hides; the destination opens a dedicated
visiting-pet window keyed by owner host. Owner identity - not pet package ID - is
the window key, so two people may select the same pet without colliding.

The destination must have the selected pet installed and healthy. The bundled
built-in pet works without extra setup. Missing or broken catalog assets are
skipped with a scoped diagnostic;
the local pet and LAN polling continue normally. Visiting windows close when
their pet leaves, their owner disconnects, or LAN polling exceeds its failure
threshold. This phase contains no meeting dialogue, MCP relay, or social
animation.

This rendering phase has been exercised with two isolated Electron profiles on
one computer. The test covered both handoff directions, two independently
draggable built-in pets on one host, return cleanup, and stale-client pruning
after one instance disconnected. Validation across two physical machines is
still pending.

### Experimental privacy-preserving work returns

Phase 3 adds an intentionally narrow MCP-to-LAN signal. When a host's default
pet is visiting another pet and receives a `working`, `editing`, `running`, or
`testing` reaction, its client may publish only `{ ownerHost, kind: "work" }`.
Actual MCP messages, prompts, speech, media, tool names, and explicit-lease pet
activity never cross the LAN boundary. Message-bearing activity requests are
rejected by the coordinator.

The shared LAN token grants access to the coordinator but does not establish a
host identity. Registration therefore issues a random per-host session
credential. Position, claim, activity, and return mutations must present the
session belonging to the host they act for. An active identity cannot be
replaced by another shared-token peer; after its client becomes stale, a
restarted client can register again and receives a rotated session.

The meeting host consumes each fresh work sequence once. The visiting pet says
the built-in line “Oh, I've got to get back to work!”, plays its configured
`running` animation as a dash, and then returns to its owner. No signal is sent
when the pet is already home, is not meeting another pet, or receives a
non-work reaction. The coordinator independently enforces the active-meeting
condition. Stale signals are consumed without replaying dialogue, activity
ordering remains monotonic across later visits, and a transient return failure
is retried without repeating the dialogue.

## Server PC

PowerShell:

```powershell
$env:OPENPETS_LAN_MODE="server"
$env:OPENPETS_LAN_SERVER="http://127.0.0.1:3787"
# Optional: set this to override the auto-generated server token
$env:OPENPETS_LAN_TOKEN="choose-a-long-shared-secret"
pnpm --filter @open-pets/desktop dev
```

Use this PC's LAN IP for other machines. Example: `http://192.168.1.37:3787`.

Server mode is authenticated by default. If `OPENPETS_LAN_TOKEN` is not set, OpenPets generates a shared token and stores it in app user data as `lan-auth.json`; the Control Center LAN tab shows the token source and a last-four-character hint. Copy the token from the server PC's `lan-auth.json` into `OPENPETS_LAN_TOKEN` on each client PC.

## Client PCs

PowerShell:

```powershell
$env:OPENPETS_LAN_MODE="client"
$env:OPENPETS_LAN_SERVER="http://192.168.1.37:3787"
$env:OPENPETS_LAN_TOKEN="choose-a-long-shared-secret"
pnpm --filter @open-pets/desktop dev
```

## Optional topology

By default, edge handoff falls back to connected hosts sorted by name. For a real office layout, set `OPENPETS_LAN_TOPOLOGY` on the server PC to map edge directions to neighboring hosts:

```powershell
$env:OPENPETS_LAN_TOPOLOGY='{"front-desk":{"right":"design-pc"},"design-pc":{"left":"front-desk","right":"qa-pc","down":"meeting-room"},"qa-pc":{"left":"design-pc"},"meeting-room":{"up":"design-pc"}}'
```

Use reciprocal links for normal two-way movement, for example `front-desk.right = design-pc` and `design-pc.left = front-desk`. The Control Center LAN tab reports topology host/link counts and warns about self-references or one-way links that are probably accidental.

If a configured neighbor is offline, OpenPets falls back to the sorted connected-host cycle.

## Windows firewall

Run this once on the server PC from an elevated PowerShell prompt:

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/open-lan-firewall.ps1
```

For a custom LAN port:

```powershell
powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/open-lan-firewall.ps1 -Port 3999
```

From a client PC, verify the server is reachable before starting client mode:

```powershell
Test-NetConnection 192.168.1.37 -Port 3787
```

## Notes

- Port `3787` must be reachable on the server PC; on Windows, use `apps/desktop/scripts/open-lan-firewall.ps1`.
- Server mode requires token auth by default. Set `OPENPETS_LAN_TOKEN` to the same long shared secret on all LAN machines, or let the server generate `lan-auth.json` and copy that token to clients.
- Client mode uses only `OPENPETS_LAN_TOKEN` for auth; it does not reuse a token generated by a previous server-mode run on the same machine.
- Set `OPENPETS_LAN_ALLOW_INSECURE=1` only for local testing when you intentionally want LAN mode without authentication.
- `OPENPETS_LAN_SERVER` must be an `http://` URL. LAN mode ignores unsupported schemes and falls back to the local default URL.
- Set `OPENPETS_LAN_HOSTNAME` to override the machine name shown to the coordinator.
- Set `OPENPETS_LAN_PORT` to change the coordinator port.
- Set `OPENPETS_LAN_TOPOLOGY` on the server to define physical left/right/up/down neighbors. Use reciprocal links for predictable two-way office layouts.
- The server persists the last owning host in app user data when ownership changes and lets that host reclaim ownership when it reconnects after a coordinator restart.
- Clients poll with capped retry backoff during outages and hide the local pet only after repeated missed polls.
- LAN request and response bodies are capped to small JSON payloads; the coordinator does not enable browser CORS access.
- This first slice uses a simple HTTP polling coordinator. Token auth is now on by default for server mode; a future Control Center pairing flow should replace manual token sharing.

## Packaging validation

LAN mode is included in the normal desktop main-process build. Validate with:

```powershell
pnpm --filter @open-pets/desktop build
pnpm --filter @open-pets/desktop package:dir
```

On Windows, packaging requires Developer Mode or an elevated shell because Electron Builder extracts a signing helper cache that contains symlinks. The `package` and `package:dir` scripts run a preflight check first so this fails early with an actionable message. The package output contract verifies the host-platform sharp native binary in local `package:dir` output and keeps workspace `supportedArchitectures` checks for release installs.
