# packages/mcp/src/

## Responsibility

Source implementation for the OpenPets MCP stdio server, including argument parsing, server registration, lease-aware tool execution, input validation, and sanitized structured responses.

## Design/Patterns

- **Small Server Factory**: `server.ts` centralizes tool registration and MCP metadata; tool logic stays in `tools.ts`.
- **Lease-Aware Tool Context**: `index.ts` acquires/heartbeats a pet lease and `tools.ts` reuses or reacquires it before mutating pet state.
- **Strict Input Schemas**: Zod schemas constrain reactions and speech; `saySchema` rejects multiline/code/URL/path/secret-like content before calling the desktop client.
- **Sanitized Error Boundary**: User-facing tool errors redact IPC paths, tokens, socket names, and local filesystem details.

## Data & Control Flow

1. `index.ts` parses `--pet`, `--help`, and `--version`, creates a client-backed tool context, and starts the stdio transport.
2. Startup lease acquisition runs asynchronously; heartbeat keeps the configured pet route alive while the MCP server is connected. Shutdown joins any in-flight startup acquisition before releasing its result, preventing replaced MCP processes from leaking temporary pool pets.
3. `server.ts` registers `openpets_status`, `openpets_react`, and `openpets_say` against handlers in `tools.ts`.
4. Handlers validate input, wait for lease readiness, acquire/reacquire a lease if needed, call `@open-pets/client`, and return text plus structured content.

## Integration Points

- `@open-pets/client`: IPC client, reactions, leases, status, speech.
- `@modelcontextprotocol/sdk`: MCP server and stdio transport.
- `zod`: tool input schemas.
- `@open-pets/cli`: launches this package via the `openpets mcp` wrapper.

## Files

- **index.ts**: Main entry (99 lines). Argument parsing, lease acquisition, heartbeat management, signal handling, graceful shutdown.
- **server.ts**: MCP server factory (32 lines). `createOpenPetsMcpServer()` registers `openpets_status`, `openpets_react`, `openpets_say` tools with metadata.
- **tools.ts**: Tool implementations. Zod schemas, `handleStatus()`, `handleReact()`, `handleSay()`, `createToolContext()`, `createMcpStatus()`, lease reacquisition, structured content, and error sanitization.
- **args.ts**: CLI argument parsing (57 lines). `parseMcpArgs()`, `validatePetId()`, `createHelpText()`.
- **ensure-executable.ts**: Post-build chmod for Unix (9 lines).
- **check-mcp-contract.ts**: Contract validation (excluded from detailed documentation).
