import { allowedReactions, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { defaultWaitingAnimationDurationMs, type WaitingAnimationDurationMs } from "./app-state-core.js";

export type PetMotionState = "idle" | "run-left" | "run-right";
export type UniversalSpriteState = "idle" | "running-right" | "running-left" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";
export type UserSelectableAnimationState = Exclude<UniversalSpriteState, "running-left" | "running-right">;
export type ReactionAnimationOverrides = Partial<Record<OpenPetsReaction, UserSelectableAnimationState>>;

export { defaultWaitingAnimationDurationMs, normalizeWaitingAnimationDurationMs, waitingAnimationDurationOptions, type WaitingAnimationDurationMs } from "./app-state-core.js";

export interface SpriteStateDefinition {
  readonly row: number;
  readonly frames: number;
  readonly durationMs: number;
  readonly iterations?: number | "infinite";
}

export const motionToSpriteState = {
  idle: "idle",
  "run-right": "running-right",
  "run-left": "running-left",
} as const satisfies Record<PetMotionState, UniversalSpriteState>;

export const defaultReactionToSpriteState = {
  idle: "idle",
  thinking: "review",
  working: "running",
  editing: "running",
  running: "running",
  testing: "waiting",
  waiting: "waiting",
  waving: "waving",
  success: "jumping",
  error: "failed",
  celebrating: "jumping",
} as const satisfies Record<OpenPetsReaction, UserSelectableAnimationState>;

export const defaultPetSprite = {
  fileName: "default-pet-spritesheet.webp",
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
  states: {
    idle: { row: 0, frames: 6, durationMs: 5500, iterations: "infinite" },
    "running-right": { row: 1, frames: 8, durationMs: 1060 },
    "running-left": { row: 2, frames: 8, durationMs: 1060 },
    waving: { row: 3, frames: 4, durationMs: 700, iterations: 2 },
    jumping: { row: 4, frames: 5, durationMs: 840, iterations: 2 },
    failed: { row: 5, frames: 8, durationMs: 1220, iterations: 2 },
    waiting: { row: 6, frames: 6, durationMs: defaultWaitingAnimationDurationMs },
    running: { row: 7, frames: 6, durationMs: 820 },
    review: { row: 8, frames: 6, durationMs: 1030 },
  } satisfies Record<UniversalSpriteState, SpriteStateDefinition>,
} as const;

export const selectableAnimationMetadata = [
  { id: "idle", label: "Idle", description: "Neutral/no special movement." },
  { id: "review", label: "Review", description: "Thinking, reading, reviewing." },
  { id: "running", label: "Running", description: "Active work, editing, executing." },
  { id: "waiting", label: "Waiting", description: "Waiting, blocked, testing, permission pending." },
  { id: "waving", label: "Waving", description: "Attention, greeting, notification." },
  { id: "jumping", label: "Jumping", description: "Success, celebration." },
  { id: "failed", label: "Failed", description: "Error or failure." },
] as const satisfies readonly { readonly id: UserSelectableAnimationState; readonly label: string; readonly description: string }[];

export const reactionAnimationMetadata = [
  { id: "idle", label: "Idle", description: "Explicit neutral reaction.", defaultAnimation: defaultReactionToSpriteState.idle },
  { id: "thinking", label: "Thinking", description: "Agent is reasoning or reviewing.", defaultAnimation: defaultReactionToSpriteState.thinking },
  { id: "working", label: "Working", description: "Agent is doing general tool work.", defaultAnimation: defaultReactionToSpriteState.working },
  { id: "editing", label: "Editing", description: "Agent is changing files.", defaultAnimation: defaultReactionToSpriteState.editing },
  { id: "running", label: "Running", description: "Agent is running a command.", defaultAnimation: defaultReactionToSpriteState.running },
  { id: "testing", label: "Testing", description: "Agent is running checks.", defaultAnimation: defaultReactionToSpriteState.testing },
  { id: "waiting", label: "Waiting", description: "Agent is blocked or waiting for permission.", defaultAnimation: defaultReactionToSpriteState.waiting },
  { id: "waving", label: "Waving", description: "Pet is greeting or getting attention.", defaultAnimation: defaultReactionToSpriteState.waving },
  { id: "success", label: "Success", description: "Task completed successfully.", defaultAnimation: defaultReactionToSpriteState.success },
  { id: "error", label: "Error", description: "Something failed.", defaultAnimation: defaultReactionToSpriteState.error },
  { id: "celebrating", label: "Celebrating", description: "Positive manual reaction.", defaultAnimation: defaultReactionToSpriteState.celebrating },
] as const satisfies readonly { readonly id: OpenPetsReaction; readonly label: string; readonly description: string; readonly defaultAnimation: UserSelectableAnimationState }[];

const allowedReactionSet = new Set<OpenPetsReaction>(allowedReactions);
const selectableAnimationSet = new Set<UserSelectableAnimationState>(selectableAnimationMetadata.map((animation) => animation.id));

export function getConfiguredSpriteStates(waitingAnimationDurationMs: WaitingAnimationDurationMs = defaultWaitingAnimationDurationMs): Record<UniversalSpriteState, SpriteStateDefinition> {
  return {
    ...defaultPetSprite.states,
    waiting: {
      ...defaultPetSprite.states.waiting,
      durationMs: waitingAnimationDurationMs,
    },
  };
}

export function getConfiguredSpriteCacheKey(waitingAnimationDurationMs: WaitingAnimationDurationMs): string {
  return `waiting-animation-duration:${waitingAnimationDurationMs}`;
}

export function isUserSelectableAnimationState(value: unknown): value is UserSelectableAnimationState {
  return typeof value === "string" && selectableAnimationSet.has(value as UserSelectableAnimationState);
}

export function normalizeReactionAnimationOverrides(value: unknown): ReactionAnimationOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const overrides: ReactionAnimationOverrides = {};
  for (const [reaction, animation] of Object.entries(value)) {
    if (!allowedReactionSet.has(reaction as OpenPetsReaction) || !isUserSelectableAnimationState(animation)) continue;
    if (defaultReactionToSpriteState[reaction as OpenPetsReaction] !== animation) overrides[reaction as OpenPetsReaction] = animation;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function validateReactionAnimationOverrides(value: unknown): ReactionAnimationOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid reaction animation overrides.");
  for (const [reaction, animation] of Object.entries(value)) {
    if (!allowedReactionSet.has(reaction as OpenPetsReaction)) throw new Error("Invalid reaction animation reaction.");
    if (!isUserSelectableAnimationState(animation)) throw new Error("Invalid reaction animation state.");
  }
  return normalizeReactionAnimationOverrides(value);
}

export function resolveReactionSpriteState(reaction: OpenPetsReaction | undefined, overrides: ReactionAnimationOverrides | undefined): UserSelectableAnimationState {
  if (!reaction) return "idle";
  return overrides?.[reaction] ?? defaultReactionToSpriteState[reaction] ?? "idle";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
