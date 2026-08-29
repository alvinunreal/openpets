#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/openpets-metrics.service"

if [[ -z "$NODE" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=OpenPets system-resources metrics sidecar
After=default.target

[Service]
Type=simple
ExecStart=${NODE} ${ROOT}/sidecar/metrics-server.mjs
WorkingDirectory=${ROOT}
Restart=always
RestartSec=2
Environment=OPENPETS_METRICS_PORT=37647
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now openpets-metrics.service
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
fi
echo "Sidecar listening on http://127.0.0.1:37647/metrics"
