import { t } from "./i18n/index.js";
import type { VoiceOperationSnapshot } from "./voice-operation-state.js";

export type TrayVoiceMenuItem = {
  readonly label: string;
  readonly click: () => void;
};

export function createVoiceMenuItems(operation: VoiceOperationSnapshot | null): TrayVoiceMenuItem[] {
  if (!operation) return [];
  return [{
    label: operation.phase === "transcribing" ? t("tray.cancelVoiceTranscription") : t("tray.cancelVoiceListening"),
    click: () => { void operation.cancel().catch(() => undefined); },
  }];
}
