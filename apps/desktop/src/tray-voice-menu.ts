import { t } from "./i18n/index.js";
import type { VoiceOperationSnapshot } from "./voice-operation-state.js";
import type { VoiceAssistantSessionStatus } from "./voice-assistant-session.js";

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

export function createVoiceAssistantTalkMenuLabel(status: VoiceAssistantSessionStatus): string {
  return status === "ended" ? t("tray.talk") : t("tray.endTalk");
}
