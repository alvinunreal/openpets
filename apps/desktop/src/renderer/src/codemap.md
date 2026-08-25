# apps/desktop/src/renderer/src/

## Responsibility

React/Tailwind source for the Control Center management UI. This renderer presents dashboard status, pet management, coding-agent integrations, plugin management, and settings using narrow preload APIs backed by `windows.ts` IPC handlers and desktop services.

## Design

- **Route Shell**: In-renderer route state supports `dashboard`, `pets`, `integrations`, `plugins`, and `settings`; tray actions retarget the singleton window through route-change events.
- **Dashboard**: Reads a narrowed dashboard snapshot for default pet preview, install/catalog counts, plugin health, update status, and activity totals.
- **Pets**: Combines installed pets, catalog v3 pages/search, Codex imports, filters, detail panes, set-default/install/import/remove actions, and animated sprite previews.
- **Integrations**: Card-first setup UI for Claude Code, OpenCode, Cursor, and Pi guidance, including command mode/path controls and preview/action flows.
- **Plugins**: Gallery-first plugin hub for installed/catalog/local/broken filters, catalog refresh, local load, install/update/uninstall, enable/disable, config modal, command execution, runtime/status display, and broken-state feedback.
- **Settings**: Startup, launch-at-login, pet scale, host Pet Assistant personality, reaction-animation mapping, model and speech provider profiles (Text & reasoning, STT, TTS), realtime status, host capability gates, update check, default-pet position reset, and pet reaction previews.
- **Bridge Contract**: All data and actions go through `window.openPetsControlCenter`; page snapshots intentionally omit raw install paths and unrelated app state.

## Key Files

- `main.tsx`: Single-file React app containing type definitions, route shell, page components, icons, snapshot loading, and action handlers.
- `styles.css`: Tailwind base/components/utilities plus glass-card layout, navigation, galleries, modals, status pills, previews, and notifications.
- `vite-env.d.ts`: Vite/TypeScript renderer environment declarations.
