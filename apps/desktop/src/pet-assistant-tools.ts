import type {
  AssistantJsonObject,
  PetAssistantCapability,
  PetAssistantCapabilitySnapshot,
  PetAssistantTool,
} from "./pet-assistant-types.js";

const providerSafeName = /^[A-Za-z0-9_-]+$/;

export type PetAssistantToolTarget = {
  readonly pluginId: string;
  readonly capabilityId: string;
  readonly handle: PetAssistantCapability["handle"];
};

export type PetAssistantToolSet = {
  readonly tools: readonly PetAssistantTool[];
  readonly targetsByName: ReadonlyMap<string, PetAssistantToolTarget>;
  readonly snapshot: PetAssistantCapabilitySnapshot;
};

/** A stable, opaque name suitable for providers that reject punctuation. */
export function petAssistantToolName(pluginId: string, capabilityId: string): string {
  const identity = `${pluginId}\u0000${capabilityId}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x01000193);
  }
  return `op_${toHex(first)}${toHex(second)}`;
}

export function buildPetAssistantTools(snapshot: PetAssistantCapabilitySnapshot): PetAssistantToolSet {
  const capabilities = [...snapshot.capabilities]
    .map((entry) => cloneCapability(entry))
    .sort((left, right) => {
      const pluginOrder = compare(left.pluginId, right.pluginId);
      return pluginOrder || compare(left.capability.id, right.capability.id);
    });
  const tools: PetAssistantTool[] = [];
  const targetsByName = new Map<string, PetAssistantToolTarget>();
  const identities = new Set<string>();

  for (const entry of capabilities) {
    const target = { pluginId: entry.pluginId, capabilityId: entry.capability.id, handle: entry.handle };
    const identity = `${target.pluginId}\u0000${target.capabilityId}`;
    if (identities.has(identity)) throw new Error(`Duplicate assistant capability: ${target.pluginId}/${target.capabilityId}.`);
    identities.add(identity);

    const name = petAssistantToolName(target.pluginId, target.capabilityId);
    if (!providerSafeName.test(name)) throw new Error("Assistant tool name is not provider-safe.");
    const existing = targetsByName.get(name);
    if (existing && (existing.pluginId !== target.pluginId || existing.capabilityId !== target.capabilityId)) {
      throw new Error(`Assistant tool name collision for ${name}.`);
    }
    targetsByName.set(name, target);
    tools.push(Object.freeze({
      name,
      description: entry.capability.description,
      inputSchema: entry.capability.inputSchema,
    }));
  }

  return Object.freeze({
    tools: Object.freeze(tools),
    targetsByName,
    snapshot: Object.freeze({
      capabilities: Object.freeze(capabilities),
    }),
  });
}

function cloneCapability(value: PetAssistantCapability): PetAssistantCapability {
  if (!value || typeof value.pluginId !== "string" || value.pluginId.length === 0) throw new Error("Invalid assistant capability plugin id.");
  if (!value.capability || typeof value.capability.id !== "string" || value.capability.id.length === 0) throw new Error("Invalid assistant capability id.");
  if (!value.handle || typeof value.handle !== "object") throw new Error("Invalid assistant capability handle.");
  if (typeof value.capability.description !== "string" || value.capability.description.trim() === "") throw new Error("Invalid assistant capability description.");
  if (!isPlainObject(value.capability.inputSchema)) throw new Error("Invalid assistant capability input schema.");
  return Object.freeze({
    pluginId: value.pluginId,
    handle: value.handle,
    capability: Object.freeze({
      id: value.capability.id,
      description: value.capability.description,
      inputSchema: cloneAndFreezeJsonObject(value.capability.inputSchema),
    }),
  });
}

function cloneAndFreezeJsonObject(value: AssistantJsonObject): AssistantJsonObject {
  const clone = (input: unknown): unknown => {
    if (Array.isArray(input)) return Object.freeze(input.map(clone));
    if (input && typeof input === "object") {
      const object: AssistantJsonObject = {};
      for (const [key, child] of Object.entries(input)) object[key] = clone(child);
      return Object.freeze(object);
    }
    return input;
  };
  return clone(value) as AssistantJsonObject;
}

function isPlainObject(value: unknown): value is AssistantJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
