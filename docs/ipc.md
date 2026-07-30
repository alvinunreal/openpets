# Local IPC Protocol & Client

Everything an agent does to a pet travels over a **local IPC channel** between
the agent-side code and the desktop app. The wire contract is defined by
`@open-pets/client` (`packages/client/`) and served by the desktop's
`local-ipc.ts`. This doc explains the transport, the discovery handshake, the
lease model, and the request surface. It is the contract both sides must agree
on; the client package is the source of truth for exact shapes.

Source maps: `packages/client/src/codemap.md` (client),
`apps/desktop/src/codemap.md` (server side: `local-ipc*.ts`, `lease-manager.ts`).

## Why local IPC and not HTTP

The pet app is a local companion. Commands are tiny, frequent, and must never
leave the machine. A local socket gives low latency, no network exposure, and a
natural place to enforce trust (a token + a private endpoint). The protocol is a
**line-delimited JSON** request/response over a single connection per call.

## Transports

The client and server pick a transport per platform:

- **Unix domain socket** — macOS and Linux.
- **Windows named pipe** — Windows.
- **TCP (IPv4)** — used for cross-platform/WSL: a WSL client connects to the
  Windows desktop app over a private IP.

TCP is the one that touches the network, so it is locked down (see Security).

## Discovery handshake

The app writes a **discovery file** at a platform-specific path
(`local-ipc-paths.ts` on the server, `discovery.ts` on the client). The file
contains the endpoint to connect to and an auth **token**. A client:

1. Reads and validates the discovery file (size, permissions, symlink checks;
   on Linux, `XDG_RUNTIME_DIR` must be `0o700` and owned by the user).
2. Parses + validates the endpoint (`parseIpcEndpoint` / `validateEndpoint`).
3. Opens a connection and sends a request carrying the token.

If the file is missing or the app is down, the client fails fast — integrations
treat the app as "unavailable" and degrade gracefully rather than blocking the
agent.

## Protocol shape

Defined in `protocol.ts` (client) and `local-ipc-protocol.ts` (server):

- Protocol **version** `v1`, validated on both ends.
- A message is one JSON object terminated by `\n`. Max message size **16KB**.
- Timeouts: ~2s to connect, ~3s for a response.
- Requests carry `{ id, version, token, method, params }`.
- Responses are a discriminated union on `ok`: `{ ok: true, ... }` or
  `{ ok: false, error, code }`. The client raises a typed `OpenPetsClientError`
  with an error code on failure.

The client factory `createOpenPetsClient(options)` exposes the high-level
methods; `sendRequest()` is the low-level escape hatch. Result parsers validate
shapes before returning.

## Request surface

| Method | Purpose |
|--------|---------|
| `hello` | Handshake / liveness probe |
| `status` | App + pet status snapshot |
| `pets.list` | Installed pets |
| `pets.install` | Install a catalog pet through the running app |
| `pets.install-local` | Install a local pet from an absolute zip-file or folder path |
| `pet.react` | Set a pet reaction (animation state) |
| `pet.say` | Show a speech bubble on a pet |
| `pet.showMedia` | Show a local image inside a pet's speech bubble |
| `lease.acquire` / `lease.heartbeat` / `lease.release` | Manage a pet lease |

Client method names (`hello()`, `status()`, `listPets()`, `installPet()`,
`installLocalPet()`, `acquireLease()`, `heartbeatLease()`, `releaseLease()`,
`react()`, `say()`, `showMedia()`) wrap these. `installLocalPet()` requires an
absolute path and an explicit `zip`/`folder` kind. `react()`/`say()`/
`showMedia()` accept an optional `leaseId` to target a specific pet.

Experimental multi-pet LAN mode converts only default-target `working`,
`editing`, `running`, and `testing` reactions into a coarse authenticated
`work` activity when the owner's pet is away and meeting another pet. The LAN
request contains no MCP text or arbitrary message field; `pet.say`,
`pet.showMedia`, non-work reactions, and explicit lease targets remain local.
The LAN coordinator binds these mutations to a per-host session credential
issued during registration; possession of the shared LAN token alone cannot
publish activity or return a pet for another active host.

`pet.showMedia` renders a local image file as a transient media bubble on the
pet — for example an image a local generation tool just produced. Params:
`path` (required absolute path, extension must be `.png`/`.jpg`/`.jpeg`/
`.webp`/`.gif`, file capped at 10 MB), optional `message` (validated exactly
like `pet.say`), optional `reaction`, and optional `durationMs` (1000–30000,
default 8000). The image never leaves the machine: the app reads the validated
local file and renders it inside the bubble via a `file:` URL, sized to the
bubble's media constraints.

`pet.showMedia` also accepts an optional `clickUrl`: clicking the media bubble
opens it via the shell on top of the normal dismiss behavior, so the sender
can hand the click back to itself (a custom registered app protocol) or to a
site (`https:`). Validation is deny-list based: local-content and script
schemes (`file:`, `javascript:`, `data:`, …), plain `http:`, and side-effect
Windows shell handlers are rejected; unregistered custom schemes are an OS
no-op.

## The lease model

Leases are how multiple agents and the default pet coexist without fighting over
one window. The model (server side in `lease-manager.ts`):

- A lease is a short-lived claim with a **15s TTL**, kept alive by heartbeats.
- `resolveTarget()` decides whether a command hits the **default pet** or an
  **explicit agent pet**.
- **Re-acquiring is idempotent per client.** When a client process re-acquires
  while it still holds a live lease, the manager refreshes that existing lease
  (same `leaseId`, same target) instead of resolving a new target. This stops a
  transient heartbeat lapse from silently *downgrading* an explicit agent pet to
  the default pet on the next acquire. Client identity is the **client PID plus a
  per-process `sessionNonce`** (a random id minted once per client process), so a
  recycled PID belonging to a brand-new process is treated as a distinct session
  and gets its own pet rather than inheriting the previous session's lease. On
  reuse the manager also re-validates that the held target is still eligible; if
  it is not (for example the pet was uninstalled or went broken), it releases the
  stale lease and resolves a fresh target instead of handing back an unavailable
  pet.
- The **first** explicit lease for a pet triggers `showAgentPet()`; the **last**
  explicit lease released triggers `closeAgentPetIfOpen()`. So agent pets appear
  on demand and disappear when their agents are done.
- **Liveness reclaims dead sessions.** A periodic check releases a lease once its
  owning process is gone, probing the **terminal owner PID** (when known) as well
  as the client PID — so a lease can't outlive its session even when the client
  process is orphaned but still alive.
- The default pet is persistent and not lease-bound.

Integrations follow a consistent pattern: acquire a lease on first activity,
heartbeat on an interval (the MCP server uses ~5s; OpenCode renews with a ~2s
buffer before expiry), and release on shutdown. If a heartbeat fails, an
integration first stashes the stale `leaseId` and retries `lease.heartbeat` to
restore it before falling back to a fresh `lease.acquire`, so a dropped heartbeat
never re-routes an agent pet onto the default. The MCP server additionally
releases its lease and exits **exactly once** when its stdio transport closes (or
on `SIGINT`/`SIGTERM`), so the pet tears down promptly when the session ends and
the shutdown path never runs twice. Failures are swallowed so the agent is never
blocked by pet IPC.

See [pets.md](pets.md) for what happens once a command reaches a pet window, and
[agent-integrations.md](agent-integrations.md) for how each integration drives
this surface.

## Reaction validation

Reactions are a closed enum. The client validates a reaction against the allowed
set before sending, and `@open-pets/agent-events` validates *speech* strings
(single line, length-bounded, no code/URLs/paths/secrets) so nothing unsafe ever
reaches a bubble. See [agent-integrations.md](agent-integrations.md).

## Security

- **Token auth** on every request; the token comes only from the discovery file,
  which is permission-checked.
- **TCP is private-only.** IPv4 addresses only (no hostnames); allowed ranges are
  loopback `127.0.0.0/8`, private `10/8`, `172.16/12`, `192.168/16`, and
  link-local `169.254/16`. `0.0.0.0`, public IPs, and hostnames are rejected.
  This is exactly enough to let a WSL client reach the Windows host and nothing
  more.
- **Size + timeout caps** bound resource use and protect against malformed input.

## Contracts

- `packages/client/contracts/client-protocol.contract.ts` — client-side protocol
  validation.
- `apps/desktop/contracts/local-ipc-protocol.contract.ts` — server-side
  request/response parsing.

These run in the test suite ([testing-and-validation.md](testing-and-validation.md))
and are the guardrail against protocol drift between client and app.
</content>
