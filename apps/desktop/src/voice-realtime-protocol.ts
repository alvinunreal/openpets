import type { PetAssistantToolResult } from "./pet-assistant-types.js";

export const VOICE_REALTIME_MAX_EVENT_BYTES = 64 * 1024;
export const VOICE_REALTIME_MAX_CALL_ID_BYTES = 256;
export const VOICE_REALTIME_MAX_TOOL_NAME_BYTES = 256;

/** Provider wire encoding stays in this adapter-only module. */
export function createOpenAIRealtimeToolResultEvents(callId: string, result: PetAssistantToolResult): readonly string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(callId) || Buffer.byteLength(callId, "utf8") > VOICE_REALTIME_MAX_CALL_ID_BYTES) throw new Error("Realtime tool call id is invalid.");
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output, "utf8") > VOICE_REALTIME_MAX_EVENT_BYTES) throw new Error("Realtime capability result is too large.");
  return Object.freeze([
    JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } }),
    JSON.stringify({ type: "response.create" }),
  ]);
}

export function parseStrictJsonObject(value: string): Record<string, unknown> | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > VOICE_REALTIME_MAX_EVENT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const prototype = Object.getPrototypeOf(parsed);
    return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
