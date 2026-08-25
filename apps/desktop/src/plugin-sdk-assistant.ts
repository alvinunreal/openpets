import type { OpenPetsAssistantCapability, OpenPetsAssistantCapabilityHandler } from "@open-pets/plugin-sdk";

import { pluginSdkQuotas } from "./plugin-sdk-quotas.js";

const assistantIdPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const schemaTypes = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);
const schemaKeywords = new Set([
  "type", "properties", "required", "additionalProperties", "description", "enum", "const",
  "minLength", "maxLength", "minimum", "maximum", "items", "minItems", "maxItems",
]);
const dangerousPropertyNames = new Set(["__proto__", "constructor", "prototype"]);

type JsonObject = Record<string, unknown>;
type JsonCounters = { properties: number };

export type AssistantSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

export type ValidatedAssistantSchema = {
  readonly type: AssistantSchemaType;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, ValidatedAssistantSchema>>;
  readonly required: ReadonlySet<string>;
  readonly additionalProperties: boolean;
  readonly items?: ValidatedAssistantSchema;
  readonly enumValues?: readonly unknown[];
  readonly constValue?: unknown;
  readonly minLength?: number;
  readonly maxLength: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems: number;
  readonly maxItems: number;
};

export type PluginAssistantCapabilityRegistration = {
  readonly capability: OpenPetsAssistantCapability;
  readonly schema: ValidatedAssistantSchema;
  readonly handler: OpenPetsAssistantCapabilityHandler;
  readonly generation: number;
};

export type PluginAssistantCapability = {
  readonly pluginId: string;
  readonly capability: OpenPetsAssistantCapability;
  readonly handle: PluginAssistantCapabilityHandle;
};

/**
 * An opaque reference to one registration in one plugin runtime generation.
 * The bridge is the only authority that can resolve or execute this value.
 */
declare const pluginAssistantCapabilityHandleBrand: unique symbol;
export type PluginAssistantCapabilityHandle = {
  readonly [pluginAssistantCapabilityHandleBrand]: true;
};

export type PluginAssistantCapabilityErrorStage = "handle" | "lifecycle" | "input" | "handler" | "result";
export type PluginAssistantCapabilityErrorCode =
  | "invalid_handle"
  | "inactive_plugin"
  | "stale_generation"
  | "invalid_input"
  | "handler_failed"
  | "timeout"
  | "invalid_result"
  | "internal_error";

export class PluginAssistantCapabilityError extends Error {
  readonly name = "PluginAssistantCapabilityError";

  constructor(
    readonly stage: PluginAssistantCapabilityErrorStage,
    readonly code: PluginAssistantCapabilityErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly missingInformation?: boolean },
  ) {
    super(message, options);
    this.missingInformation = options?.missingInformation === true;
  }

  readonly missingInformation: boolean;
}

export type PluginAssistantCapabilityErrorInfo = {
  readonly stage: PluginAssistantCapabilityErrorStage;
  readonly code: PluginAssistantCapabilityErrorCode;
  readonly message: string;
  readonly missingInformation?: boolean;
};

export type PluginAssistantCapabilityExecutionOutcome =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly ok: false; readonly error: PluginAssistantCapabilityErrorInfo };

export function assistantCapabilityFailure(error: unknown, fallbackStage: PluginAssistantCapabilityErrorStage = "handler"): PluginAssistantCapabilityExecutionOutcome {
  if (error instanceof PluginAssistantCapabilityError) return { ok: false, error: { stage: error.stage, code: error.code, message: error.message, ...(error.missingInformation ? { missingInformation: true } : {}) } };
  return {
    ok: false,
    error: { stage: fallbackStage, code: "internal_error", message: error instanceof Error ? error.message : "Plugin assistant capability failed." },
  };
}

type ParsedSchema = { readonly schema: ValidatedAssistantSchema; readonly raw: JsonObject };

/** Validate and clone a capability descriptor before it enters plugin state. */
export function validateAssistantCapability(value: unknown): { capability: OpenPetsAssistantCapability; schema: ValidatedAssistantSchema } {
  if (!isPlainObject(value)) throw new Error("Invalid assistant capability descriptor.");
  const keys = Object.keys(value);
  if (keys.some((key) => !["id", "description", "inputSchema"].includes(key))) throw new Error("Unsupported assistant capability descriptor field.");
  if (typeof value.id !== "string" || !assistantIdPattern.test(value.id)) throw new Error("Invalid assistant capability id.");
  if (typeof value.description !== "string" || value.description.trim() === "" || value.description.length > pluginSdkQuotas.assistantCapabilityDescriptionChars) throw new Error("Invalid assistant capability description.");

  const parsed = parseSchema(value.inputSchema, 0, { properties: 0 });
  if (parsed.schema.type !== "object") throw new Error("Assistant capability inputSchema must have type object.");
  if (jsonBytes(parsed.raw) > pluginSdkQuotas.assistantSchemaBytes) throw new Error("Assistant capability inputSchema is too large.");

  return {
    capability: { id: value.id, description: value.description, inputSchema: parsed.raw },
    schema: parsed.schema,
  };
}

/** Validate and clone a host-supplied capability input against its schema. */
export function validateAssistantInput(schema: ValidatedAssistantSchema, value: unknown): Record<string, unknown> {
  const counters: JsonCounters = { properties: 0 };
  const normalized = validateSchemaValue(schema, value, "assistant capability input", 0, counters);
  if (!isPlainObject(normalized)) throw new Error("Assistant capability input must be an object.");
  if (jsonBytes(normalized) > pluginSdkQuotas.assistantInputBytes) throw new Error("Assistant capability input is too large.");
  return normalized;
}

/** Validate and clone a structured capability result. */
export function normalizeAssistantResult(value: unknown): Record<string, unknown> {
  const normalized = cloneJson(value, "assistant capability result", 0, new Set<object>(), { properties: 0 });
  if (!isPlainObject(normalized)) throw new Error("Assistant capability result must be an object.");
  if (jsonBytes(normalized) > pluginSdkQuotas.assistantResultBytes) throw new Error("Assistant capability result is too large.");
  return normalized;
}

function parseSchema(value: unknown, depth: number, counters: JsonCounters): ParsedSchema {
  if (depth > pluginSdkQuotas.assistantSchemaDepth || !isPlainObject(value)) throw new Error("Invalid assistant capability schema.");
  for (const key of Object.keys(value)) {
    if (!schemaKeywords.has(key)) throw new Error(`Unsupported assistant capability schema keyword: ${key}.`);
  }

  const type = value.type;
  if (typeof type !== "string" || !schemaTypes.has(type)) throw new Error("Assistant capability schema type is unsupported or missing.");
  const schemaType = type as AssistantSchemaType;
  const raw: JsonObject = { type: schemaType };
  const description = readDescription(value.description);
  if (description !== undefined) raw.description = description;

  const enumValues = hasOwn(value, "enum") ? readEnum(value.enum) : undefined;
  if (enumValues !== undefined) raw.enum = enumValues;
  const constValue = hasOwn(value, "const") ? cloneJson(value.const, "assistant capability schema const", 0, new Set<object>(), { properties: 0 }) : undefined;
  if (hasOwn(value, "const")) raw.const = constValue;

  if (schemaType !== "string" && (hasOwn(value, "minLength") || hasOwn(value, "maxLength"))) throw new Error("Assistant capability string bounds require type string.");
  if (schemaType !== "number" && schemaType !== "integer" && (hasOwn(value, "minimum") || hasOwn(value, "maximum"))) throw new Error("Assistant capability numeric bounds require type number or integer.");
  if (schemaType !== "array" && (hasOwn(value, "items") || hasOwn(value, "minItems") || hasOwn(value, "maxItems"))) throw new Error("Assistant capability array bounds require type array.");
  if (schemaType !== "object" && (hasOwn(value, "properties") || hasOwn(value, "required") || hasOwn(value, "additionalProperties"))) throw new Error("Assistant capability object fields require type object.");

  const minLength = schemaType === "string" ? readIntegerBound(value, "minLength", 0, pluginSdkQuotas.assistantStringChars) : undefined;
  const maxLength = schemaType === "string" ? readIntegerBound(value, "maxLength", 0, pluginSdkQuotas.assistantStringChars) ?? pluginSdkQuotas.assistantStringChars : pluginSdkQuotas.assistantStringChars;
  if (minLength !== undefined && minLength > maxLength) throw new Error("Assistant capability string bounds are invalid.");
  if (minLength !== undefined) raw.minLength = minLength;
  if (hasOwn(value, "maxLength")) raw.maxLength = maxLength;

  const minimum = schemaType === "number" || schemaType === "integer" ? readNumberBound(value, "minimum") : undefined;
  const maximum = schemaType === "number" || schemaType === "integer" ? readNumberBound(value, "maximum") : undefined;
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error("Assistant capability numeric bounds are invalid.");
  if (minimum !== undefined) raw.minimum = minimum;
  if (maximum !== undefined) raw.maximum = maximum;

  let properties: Record<string, ValidatedAssistantSchema> | undefined;
  let required = new Set<string>();
  let additionalProperties = true;
  if (schemaType === "object") {
    if (hasOwn(value, "properties")) {
      if (!isPlainObject(value.properties)) throw new Error("Assistant capability schema properties must be an object.");
      const propertyNames = Object.keys(value.properties);
      if (propertyNames.length > pluginSdkQuotas.assistantObjectProperties) throw new Error("Assistant capability schema has too many properties.");
      properties = Object.create(null) as Record<string, ValidatedAssistantSchema>;
      const rawProperties: JsonObject = {};
      for (const name of propertyNames) {
        assertPropertyName(name);
        counters.properties += 1;
        if (counters.properties > pluginSdkQuotas.assistantSchemaProperties) throw new Error("Assistant capability schema has too many nested properties.");
        const child = parseSchema(value.properties[name], depth + 1, counters);
        properties[name] = child.schema;
        rawProperties[name] = child.raw;
      }
      raw.properties = rawProperties;
    }
    if (hasOwn(value, "required")) {
      if (!Array.isArray(value.required) || value.required.length > pluginSdkQuotas.assistantObjectProperties) throw new Error("Assistant capability schema required must be an array.");
      for (const name of value.required) {
        if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(properties ?? {}, name) || required.has(name)) throw new Error("Assistant capability schema required contains an invalid property.");
        assertPropertyName(name);
        required.add(name);
      }
      raw.required = [...required];
    }
    if (hasOwn(value, "additionalProperties")) {
      if (typeof value.additionalProperties !== "boolean") throw new Error("Assistant capability schema additionalProperties must be boolean.");
      additionalProperties = value.additionalProperties;
      raw.additionalProperties = additionalProperties;
    }
  }

  let items: ValidatedAssistantSchema | undefined;
  let minItems: number = 0;
  let maxItems: number = pluginSdkQuotas.assistantArrayItems;
  if (schemaType === "array") {
    if (!hasOwn(value, "items")) throw new Error("Assistant capability array schema requires items.");
    const parsedItems = parseSchema(value.items, depth + 1, counters);
    items = parsedItems.schema;
    raw.items = parsedItems.raw;
    minItems = readIntegerBound(value, "minItems", 0, pluginSdkQuotas.assistantArrayItems) ?? 0;
    maxItems = readIntegerBound(value, "maxItems", 0, pluginSdkQuotas.assistantArrayItems) ?? pluginSdkQuotas.assistantArrayItems;
    if (minItems > maxItems) throw new Error("Assistant capability array bounds are invalid.");
    if (hasOwn(value, "minItems")) raw.minItems = minItems;
    if (hasOwn(value, "maxItems")) raw.maxItems = maxItems;
  }

  return {
    schema: { type: schemaType, description, properties, required, additionalProperties, items, enumValues, constValue, minLength, maxLength, minimum, maximum, minItems, maxItems },
    raw,
  };
}

function validateSchemaValue(schema: ValidatedAssistantSchema, value: unknown, label: string, depth: number, counters: JsonCounters): unknown {
  if (depth > pluginSdkQuotas.assistantValueDepth) throw new Error("Assistant capability value is too deeply nested.");
  if (schema.enumValues && !schema.enumValues.some((candidate) => jsonEqual(candidate, value))) throw new Error(`${label} is not an allowed enum value.`);
  if (schema.constValue !== undefined && !jsonEqual(schema.constValue, value)) throw new Error(`${label} does not match const.`);

  switch (schema.type) {
    case "null":
      if (value !== null) throw new Error(`${label} must be null.`);
      return null;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
      return value;
    case "string":
      if (typeof value !== "string") throw new Error(`${label} must be a string.`);
      if (value.length < (schema.minLength ?? 0) || value.length > schema.maxLength) throw new Error(`${label} has an invalid length.`);
      return value;
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value))) throw new Error(`${label} must be a ${schema.type}.`);
      if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${label} is below minimum.`);
      if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${label} is above maximum.`);
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
      if (value.length < schema.minItems || value.length > schema.maxItems) throw new Error(`${label} has an invalid item count.`);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label} must not contain sparse arrays.`);
        result.push(validateSchemaValue(schema.items!, value[index], `${label}[${index}]`, depth + 1, counters));
      }
      return result;
    }
    case "object": {
      if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
      const keys = Object.keys(value);
      if (keys.length > pluginSdkQuotas.assistantObjectProperties) throw new Error(`${label} has too many properties.`);
      const result: JsonObject = {};
      for (const key of keys) {
        assertPropertyName(key);
        counters.properties += 1;
        if (counters.properties > pluginSdkQuotas.assistantValueProperties) throw new Error(`${label} has too many nested properties.`);
        const child = schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, key) ? schema.properties[key] : undefined;
        if (child) result[key] = validateSchemaValue(child, value[key], `${label}.${key}`, depth + 1, counters);
        else if (schema.additionalProperties) result[key] = cloneJson(value[key], `${label}.${key}`, depth + 1, new Set<object>(), counters);
        else throw new Error(`${label} contains an unsupported property: ${key}.`);
      }
      for (const required of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) {
          throw new PluginAssistantCapabilityError("input", "invalid_input", `${label}.${required} is required.`, { missingInformation: true });
        }
      }
      return result;
    }
  }
}

function cloneJson(value: unknown, label: string, depth: number, stack: Set<object>, counters: JsonCounters): unknown {
  if (depth > pluginSdkQuotas.assistantValueDepth) throw new Error(`${label} is too deeply nested.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > pluginSdkQuotas.assistantStringChars) throw new Error(`${label} string is too long.`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers.`);
    return value;
  }
  if (typeof value !== "object" || !isPlainObject(value) && !Array.isArray(value)) throw new Error(`${label} must be JSON-compatible.`);
  if (stack.has(value)) throw new Error(`${label} must not contain circular data.`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > pluginSdkQuotas.assistantArrayItems) throw new Error(`${label} has too many items.`);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label} must not contain sparse arrays.`);
        result.push(cloneJson(value[index], `${label}[${index}]`, depth + 1, stack, counters));
      }
      return result;
    }
    const keys = Object.keys(value);
    if (keys.length > pluginSdkQuotas.assistantObjectProperties) throw new Error(`${label} has too many properties.`);
    const result: JsonObject = {};
    for (const key of keys) {
      assertPropertyName(key);
      counters.properties += 1;
      if (counters.properties > pluginSdkQuotas.assistantValueProperties) throw new Error(`${label} has too many nested properties.`);
      result[key] = cloneJson(value[key], `${label}.${key}`, depth + 1, stack, counters);
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function readDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > pluginSdkQuotas.assistantCapabilityDescriptionChars) throw new Error("Invalid assistant capability schema description.");
  return value;
}

function readEnum(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > pluginSdkQuotas.assistantEnumValues) throw new Error("Invalid assistant capability schema enum.");
  return value.map((entry) => cloneJson(entry, "assistant capability schema enum", 0, new Set<object>(), { properties: 0 }));
}

function readIntegerBound(value: JsonObject, key: string, min: number, max: number): number | undefined {
  if (!hasOwn(value, key)) return undefined;
  const number = value[key];
  if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid assistant capability schema ${key}.`);
  return number;
}

function readNumberBound(value: JsonObject, key: string): number | undefined {
  if (!hasOwn(value, key)) return undefined;
  const number = value[key];
  if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`Invalid assistant capability schema ${key}.`);
  return number;
}

function assertPropertyName(name: string): void {
  if (name.length < 1 || name.length > pluginSdkQuotas.assistantCapabilityIdChars || /[\0-\x1f\x7f]/.test(name) || dangerousPropertyNames.has(name)) throw new Error("Invalid assistant capability property name.");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Assistant capability data must be JSON-compatible.");
  return Buffer.byteLength(text);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
