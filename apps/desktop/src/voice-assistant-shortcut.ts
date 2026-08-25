export const DEFAULT_VOICE_ASSISTANT_SHORTCUT = "CommandOrControl+Shift+Space";

export type VoiceAssistantShortcutStatus = "registered" | "conflict" | "unavailable" | "invalid";

export type VoiceAssistantShortcutSnapshot = {
  readonly accelerator: string;
  readonly status: VoiceAssistantShortcutStatus;
  readonly reason?: string;
};

export interface GlobalShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

const MODIFIER_ORDER = ["CommandOrControl", "Command", "Control", "Alt", "Option", "Shift", "Super", "Meta"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const SPECIAL_KEYS = new Set(["Space", "Tab", "Enter", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right", "Plus", "Minus", "PrintScreen"]);

/**
 * Accept only the canonical Electron spelling and a deliberately small key
 * set. This keeps persisted shortcuts portable instead of accepting platform
 * aliases that Electron may interpret differently.
 */
export function isCanonicalVoiceAssistantShortcut(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 80 || /\s/.test(value)) return false;
  const parts = value.split("+");
  if (parts.length < 2) return false;
  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  if (modifiers.some((modifier) => !MODIFIERS.has(modifier))) return false;
  if (new Set(modifiers).size !== modifiers.length) return false;
  if (!isValidAcceleratorKey(key)) return false;
  return modifiers.every((modifier, index) => index === 0 || MODIFIER_ORDER.indexOf(modifier as typeof MODIFIER_ORDER[number]) > MODIFIER_ORDER.indexOf(modifiers[index - 1] as typeof MODIFIER_ORDER[number]));
}

export function validateVoiceAssistantShortcut(value: unknown): string {
  if (!isCanonicalVoiceAssistantShortcut(value)) throw new Error("Invalid voice assistant shortcut.");
  return value;
}

function isValidAcceleratorKey(value: string): boolean {
  return /^[A-Z0-9]$/.test(value) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(value) || SPECIAL_KEYS.has(value);
}

export class VoiceAssistantShortcutManager {
  readonly #registry: GlobalShortcutRegistry;
  readonly #onTriggered: () => void;
  #snapshot: VoiceAssistantShortcutSnapshot;
  #registeredAccelerator: string | null = null;

  constructor(registry: GlobalShortcutRegistry, onTriggered: () => void, accelerator = DEFAULT_VOICE_ASSISTANT_SHORTCUT) {
    this.#registry = registry;
    this.#onTriggered = onTriggered;
    this.#snapshot = { accelerator, status: "unavailable", reason: "Shortcut registration has not started." };
  }

  snapshot(): VoiceAssistantShortcutSnapshot { return this.#snapshot; }

  configure(accelerator: string): VoiceAssistantShortcutSnapshot {
    if (!isCanonicalVoiceAssistantShortcut(accelerator)) {
      this.#snapshot = { accelerator, status: "invalid", reason: "Shortcut must use a canonical Electron accelerator." };
      return this.#snapshot;
    }
    if (this.#registeredAccelerator === accelerator && this.#snapshot.status === "registered") return this.#snapshot;
    if (this.#registeredAccelerator && this.#snapshot.status === "unavailable") return this.#snapshot;

    const previousAccelerator = this.#registeredAccelerator;
    try {
      const registered = this.#registry.register(accelerator, this.#onTriggered);
      if (!registered) {
        this.#snapshot = previousAccelerator
          ? { accelerator: previousAccelerator, status: "registered", reason: "The requested shortcut is already in use; the previous shortcut remains active." }
          : { accelerator, status: "conflict", reason: "Another application already owns this shortcut." };
        return this.#snapshot;
      }
    } catch (error) {
      this.#snapshot = previousAccelerator
        ? { accelerator: previousAccelerator, status: "registered", reason: `The requested shortcut could not be registered; the previous shortcut remains active. ${error instanceof Error ? error.message : "The operating system rejected shortcut registration."}` }
        : { accelerator, status: "unavailable", reason: error instanceof Error ? error.message : "The operating system rejected shortcut registration." };
      return this.#snapshot;
    }

    if (previousAccelerator) {
      try {
        this.#registry.unregister(previousAccelerator);
      } catch (error) {
        try {
          this.#registry.unregister(accelerator);
        } catch (rollbackError) {
          this.#registeredAccelerator = accelerator;
          this.#snapshot = { accelerator, status: "registered", reason: `The previous shortcut could not be released and the replacement could not be rolled back. ${rollbackError instanceof Error ? rollbackError.message : "The operating system refused to release the replacement shortcut."}` };
          return this.#snapshot;
        }
        this.#snapshot = { accelerator: previousAccelerator, status: "registered", reason: `The requested shortcut could not replace the previous shortcut. ${error instanceof Error ? error.message : "The operating system refused to release the previous shortcut."}` };
        return this.#snapshot;
      }
    }

    this.#registeredAccelerator = accelerator;
    this.#snapshot = { accelerator, status: "registered" };
    return this.#snapshot;
  }

  shutdown(): VoiceAssistantShortcutSnapshot {
    if (!this.#unregisterCurrent()) {
      return this.#snapshot;
    }
    this.#snapshot = { ...this.#snapshot, status: "unavailable", reason: "Shortcut registration is stopped." };
    return this.#snapshot;
  }

  #unregisterCurrent(): boolean {
    const accelerator = this.#registeredAccelerator;
    if (!accelerator) return true;
    try {
      this.#registry.unregister(accelerator);
      this.#registeredAccelerator = null;
      return true;
    } catch (error) {
      this.#snapshot = { accelerator, status: "unavailable", reason: error instanceof Error ? error.message : "The operating system refused to release this shortcut." };
      return false;
    }
  }
}

export function resolveVoiceAssistantShortcutPreference(current: string, requested: string, snapshot: VoiceAssistantShortcutSnapshot): string {
  return snapshot.status === "registered" && snapshot.accelerator === requested ? requested : current;
}

let runtimeManager: VoiceAssistantShortcutManager | null = null;

export function initializeVoiceAssistantShortcut(registry: GlobalShortcutRegistry, onTriggered: () => void, accelerator: string): VoiceAssistantShortcutSnapshot {
  if (runtimeManager) {
    const previous = runtimeManager.shutdown();
    if (previous.reason !== "Shortcut registration is stopped.") return previous;
  }
  runtimeManager = new VoiceAssistantShortcutManager(registry, onTriggered);
  return runtimeManager.configure(accelerator);
}

export function configureVoiceAssistantShortcut(accelerator: string): VoiceAssistantShortcutSnapshot {
  if (!runtimeManager) return { accelerator, status: "unavailable", reason: "Shortcut registration is not initialized." };
  return runtimeManager.configure(accelerator);
}

export function getVoiceAssistantShortcutSnapshot(): VoiceAssistantShortcutSnapshot {
  return runtimeManager?.snapshot() ?? { accelerator: DEFAULT_VOICE_ASSISTANT_SHORTCUT, status: "unavailable", reason: "Shortcut registration is not initialized." };
}

export function shutdownVoiceAssistantShortcut(): VoiceAssistantShortcutSnapshot {
  if (!runtimeManager) return getVoiceAssistantShortcutSnapshot();
  const snapshot = runtimeManager.shutdown();
  if (snapshot.reason === "Shortcut registration is stopped.") runtimeManager = null;
  return snapshot;
}
