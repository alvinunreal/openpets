# Codex integration

This guide validates OpenPets with Codex in a project-local setup.

## Prerequisites

- OpenPets Desktop running.
- At least one usable installed pet in OpenPets.
- Node.js and npm/npx available in your shell.

## Local desktop development workflow (openpets-desktop)

If you want to run everything locally from this repository instead of published npm packages:

1. Install dependencies in the monorepo root:

```bash
pnpm install
```

2. Start OpenPets Desktop in dev mode (from repo root):

```bash
pnpm dev:desktop
```

3. In your target project directory (another terminal), configure Codex using local CLI wiring:

```bash
node /path/to/openpets/packages/cli/dist/index.js configure --agent codex --pet <petId> --local-dev --force
```

4. Confirm `.codex/config.toml` now points to a local Node command (not pinned npm package).

5. Restart Codex in that project and run `openpets_status`.

Tip: if `dist/index.js` does not exist yet, build once in repo root:

```bash
pnpm build
```

## 1) Configure this project for Codex

From your project root:

```bash
npx -y @open-pets/cli configure --agent codex --pet <petId>
```

Expected output includes:

- `OpenPets configured for Codex ...`
- `Config: <project>/.codex/config.toml`

## 2) Verify generated Codex MCP config

Open `.codex/config.toml` and confirm an `openpets` server entry exists:

```toml
[mcp_servers.openpets]
command = "npx"
args = ["-y", "@open-pets/cli@<version>", "mcp", "--pet", "<petId>"]
```

## 3) Restart Codex in the project

Restart the Codex session so it reloads MCP servers from `.codex/config.toml`.

## 4) Run smoke checks via Codex MCP tools

From Codex, call these tools in order:

1. `openpets_status` → should report OpenPets reachable.
2. `openpets_react` with `thinking` → pet should change reaction.
3. `openpets_say` with short safe text (e.g., `Build done`) → speech bubble appears.

## 5) Troubleshooting

- **"OpenPets desktop app is not running"**: open/restart OpenPets Desktop.
- **Pet not applied**: verify `<petId>` exists and is not broken.
- **Config already present**: rerun with `--force` to replace OpenPets Codex block.
- **MCP tools missing after setup**: fully restart Codex in that project.

## 6) Reconfigure with local dev command (optional)

For local package development:

```bash
npx -y @open-pets/cli configure --agent codex --pet <petId> --local-dev --force
```

This rewrites OpenPets Codex config to invoke the local CLI entrypoint instead of a published package version.
