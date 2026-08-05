# packages/mcp/

MCP (Model Context Protocol) server for OpenPets integration.

## Responsibility

Implements an MCP server exposing OpenPets functionality to AI agents via the Model Context Protocol. Provides tools for checking status, setting reactions, and displaying messages on the desktop pet.

## Design/Patterns

**MCP Server Setup** (`server.ts`):
- `McpServer` from `@modelcontextprotocol/sdk`
- Three registered tools: `openpets_status`, `openpets_react`, `openpets_say`
- Tool annotations for read-only/idempotent hints
- Instructions for AI agents (safety guidelines)

**Tool Implementations** (`tools.ts`):
- Zod schemas for input validation (`saySchema`, `reactSchema`)
- Lease-aware operations (acquires lease on startup, heartbeat every 5s, and single-flight stale-lease recovery shared with lifecycle timers)
- Throttling integration for speech/reactions
- Error sanitization (hides IPC paths, tokens, sockets, and local paths)
- Structured MCP results: tools return `structuredContent` with status, routing, lease, and operation result metadata when available.

**Lifecycle Management** (`index.ts`):
- Startup lease acquisition (async, non-blocking)
- Heartbeat timer (5s interval, unref'd)
- Graceful shutdown on SIGINT/SIGTERM (stop recovery sources, join startup/recovery, release retained lease IDs once, close server)
- Stdio transport via `StdioServerTransport`

**Argument Parsing** (`args.ts`):
- `--pet <id>` for targeted pet selection
- `--help`, `--version` flags
- Pet ID validation (regex: `^[a-z0-9][a-z0-9_-]{0,63}$`)

**Build Integration** (`ensure-executable.ts`):
- Post-build chmod 0o755 for Unix binaries

## Data & Control Flow

```
main()
    ↓
parseMcpArgs() → { petId?, help, version }
    ↓
createToolContext() → { client, configuredPetId }
    ↓
acquireStartupLease() → lease.lease set on success
    ↓
createOpenPetsMcpServer() → Register 3 tools
    ↓
server.connect(StdioServerTransport)
    ↓
[Heartbeat] Every 5s: client.heartbeatLease()
    ↓
[Shutdown] SIGINT/SIGTERM or transport close → mark shared lease context closing → stop timers → join startup/tool/timer recovery → release retained active/stale/recovered lease IDs once → server.close() → exit once
```

## Integration Points

**Dependencies**:
- `@open-pets/client` - IPC communication
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `zod` - Schema validation

**CLI Integration**: Spawned by `@open-pets/cli` via `runMcp()` which forwards stdio and signals.

**Exports**:
- Binary: `open-pets-mcp` (stdio MCP server)
- No programmatic exports (MCP server is standalone)
- Source map: [src/codemap.md](src/codemap.md)
