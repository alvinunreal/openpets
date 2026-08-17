import type { Context } from "@deepseek-ai/cordis";

export {
  classifyDshEvent,
  createOpenPetsDshClient,
  createOpenPetsDshRuntime,
  registerDshListeners,
  type DshCordisApi,
  type DshAgentStatus,
  type DshEventName,
  type DshEventDecision,
  type OpenPetsDshOptions,
  type OpenPetsDshRuntime,
} from "./runtime.js";

import { registerDshListeners, type OpenPetsDshOptions } from "./runtime.js";

export const name = "@open-pets/dsh";

/** Install the OpenPets listeners into the DSH Cordis context. */
export function apply(ctx: Context, options: OpenPetsDshOptions = {}): void {
  registerDshListeners(ctx, options);
}
