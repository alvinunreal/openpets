export const OS_IDS = ["auto", "mac", "windows", "linux"];

const ALIASES = {
  auto: "auto",
  mac: "mac",
  darwin: "mac",
  macos: "mac",
  windows: "windows",
  win: "windows",
  win32: "windows",
  linux: "linux",
};

export function normalizeOsHint(value) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  return ALIASES[key] ?? null;
}

/** Resolve plugin/sidecar OS. `hostHint` is OpenPets (`mac|win|linux`) or Node (`darwin|win32|linux`). */
export function resolveOs(raw, hostHint = "auto") {
  const requested = normalizeOsHint(raw) ?? "auto";
  if (requested !== "auto") return requested;
  const detected = normalizeOsHint(hostHint);
  if (detected && detected !== "auto") return detected;
  return "mac";
}
