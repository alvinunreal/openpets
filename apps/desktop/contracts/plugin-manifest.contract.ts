import { openPetsPluginManifestFilename, validatePluginManifest } from "../src/plugin-manifest.js";

assertEqual(openPetsPluginManifestFilename, "openpets.plugin.json");

const validManifest = {
  manifestVersion: 1,
  id: "stretch-timer",
  name: "Stretch Timer",
  version: "1.0.0",
  runtime: "declarative",
  permissions: ["timer", "pet:speak", "pet:reaction"],
  configSchema: {
    intervalMinutes: { type: "number", label: "Interval", default: 15 },
    message: { type: "text", label: "Message", default: "Time to stretch!" },
    mood: {
      type: "select",
      label: "Mood",
      default: "celebrating",
      options: [{ label: "Celebrate", value: "celebrating" }],
    },
  },
  triggers: [
    {
      on: "timer",
      everyMinutes: { config: "intervalMinutes" },
      actions: [
        { type: "pet.speak", message: "Time to stretch!" },
        { type: "pet.react", reaction: "celebrating" },
      ],
    },
  ],
};

assertValid(validManifest);
assertValid({ ...validManifest, icon: "bell" });
assertInvalid({ ...validManifest, icon: "https://example.com/icon.svg" }, "invalid_icon");
assertValid({ manifestVersion: 2, id: "js-plugin", name: "JS Plugin", version: "1.0.0", runtime: "javascript", icon: "github", sdkVersion: "1.0.0", entry: "dist/index.js", permissions: ["pet:speak", "network"], network: { hosts: ["api.example.com"] } });
assertValid({ manifestVersion: 3, id: "companion-plugin", name: "Companion Plugin", version: "1.0.0", runtime: "javascript", sdkVersion: "3.0.0", entry: "index.js", permissions: ["companion:context"] });
assertInvalid({ manifestVersion: 2, id: "js-plugin", name: "JS Plugin", version: "1.0.0", runtime: "javascript", icon: "<svg>", sdkVersion: "1.0.0", entry: "dist/index.js", permissions: ["pet:speak"] }, "invalid_icon");
assertInvalid({ manifestVersion: 2, id: "js-plugin", name: "JS Plugin", version: "1.0.0", runtime: "declarative", sdkVersion: "1.0.0", entry: "dist/index.js", permissions: ["pet:speak"] }, "invalid_runtime");
assertInvalid({ manifestVersion: 2, id: "js-plugin", name: "JS Plugin", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "../index.js", permissions: ["pet:speak"] }, "invalid_entry");
assertInvalid({ manifestVersion: 2, id: "js-plugin", name: "JS Plugin", version: "1.0.0", runtime: "javascript", sdkVersion: "1.0.0", entry: "index.js", permissions: ["network"], network: { hosts: ["*.example.com"] } }, "invalid_network_host");
assertValid({ ...validManifest, triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.speak", message: { config: "message" } }, { type: "pet.react", reaction: { config: "mood" } }] }] });
assertInvalid({ ...validManifest, triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.speak", message: { config: "message", extra: true } }] }] }, "invalid_config_reference");
assertInvalid({ ...validManifest, triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.speak", message: { config: "missing" } }] }] }, "invalid_config_reference");
assertInvalid({ ...validManifest, triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.speak", message: { config: "mood" } }] }] }, "invalid_config_reference");
assertInvalid({ ...validManifest, triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.react", reaction: { config: "message" } }] }] }, "invalid_config_reference");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", default: "celebrate", options: [{ label: "Celebrate", value: "celebrate" }] } }, triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.react", reaction: { config: "mood" } }] }] }, "invalid_reaction_config_reference");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", options: [{ label: "Celebrate", value: "celebrating" }] } }, triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.react", reaction: { config: "mood" } }] }] }, "invalid_reaction_config_reference");
assertInvalid({ ...validManifest, extra: true }, "unknown_field");
assertInvalid(
  {
    ...validManifest,
    configSchema: { intervalMinutes: { type: "number", label: "Interval", helperText: "Soon" } },
  },
  "unknown_field",
);
assertInvalid(
  {
    ...validManifest,
    triggers: [{ on: "timer", everyMinutes: 5, actions: [], jitter: true }],
  },
  "unknown_field",
);
assertInvalid(
  {
    ...validManifest,
    triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.speak", message: "Hi", unsafe: true }] }],
  },
  "unknown_field",
);
assertInvalid(
  {
    ...validManifest,
    configSchema: { mood: { type: "select", options: [{ label: "Celebrate", value: "celebrate", icon: "sparkles" }] } },
  },
  "unknown_field",
);
assertInvalid({ ...validManifest, runtime: "javascript" }, "unsupported_runtime");
assertInvalid({ ...validManifest, permissions: ["timer", "network"] }, "invalid_permission");
assertInvalid({ ...validManifest, permissions: ["timer", "pet:speak", "timer", "pet:reaction"] }, "duplicate_permission");
assertInvalid(
  {
    ...validManifest,
    triggers: [{ on: "timer", everyMinutes: { config: "missing" }, actions: [] }],
  },
  "invalid_timer_config_reference",
);
assertInvalid(
  {
    ...validManifest,
    configSchema: { notNumber: { type: "text" } },
    triggers: [{ on: "timer", everyMinutes: { config: "notNumber" }, actions: [] }],
  },
  "invalid_timer_config_reference",
);
assertInvalid(
  {
    ...validManifest,
    triggers: [{ on: "timer", everyMinutes: 5, actions: [{ type: "pet.badge", text: "Busy" }] }],
  },
  "invalid_action",
);
assertValid({ ...validManifest, configSchema: { ...validManifest.configSchema, when: { type: "time", default: "09:00" } } });
assertInvalid(
  {
    ...validManifest,
    configSchema: { days: { type: "multi-select" } },
  },
  "deferred_config_type",
);
assertInvalid(
  {
    ...validManifest,
    configSchema: { date: { type: "date" } },
  },
  "deferred_config_type",
);
assertInvalid(
  {
    ...validManifest,
    configSchema: { schedule: { type: "schedule" } },
  },
  "deferred_config_type",
);
assertInvalid(
  {
    ...validManifest,
    configSchema: { account: { type: "connection" } },
  },
  "deferred_config_type",
);
assertInvalid(
  {
    ...validManifest,
    configSchema: { token: { type: "secret" } },
  },
  "deferred_config_type",
);
assertInvalid(
  {
    ...validManifest,
    configSchema: { choices: { type: "select", dynamicOptions: true } },
  },
  "deferred_config_feature",
);
assertInvalid({ ...validManifest, configSchema: { text: { type: "text", default: 1 } } }, "invalid_default");
assertInvalid({ ...validManifest, configSchema: { text: { type: "textarea", default: false } } }, "invalid_default");
assertInvalid({ ...validManifest, configSchema: { count: { type: "number", default: Infinity } } }, "invalid_default");
assertInvalid({ ...validManifest, configSchema: { enabled: { type: "boolean", default: "yes" } } }, "invalid_default");
assertInvalid({ ...validManifest, configSchema: { text: { type: "text", options: [{ label: "A", value: "a" }] } } }, "invalid_options");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select" } } }, "invalid_options");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", options: [] } } }, "invalid_options");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", options: [{ label: "", value: "x" }] } } }, "invalid_string");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", options: [{ label: "X", value: "" }] } } }, "invalid_string");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", options: [{ label: "A", value: "x" }, { label: "B", value: "x" }] } } }, "duplicate_option_value");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", default: 1, options: [{ label: "A", value: "a" }] } } }, "invalid_default");
assertInvalid({ ...validManifest, configSchema: { mood: { type: "select", default: "b", options: [{ label: "A", value: "a" }] } } }, "invalid_default");
assertInvalid({ ...validManifest, configSchema: { text: { type: "text", label: 1 } } }, "invalid_string");
assertInvalid({ ...validManifest, configSchema: { text: { type: "text", description: false } } }, "invalid_string");
assertInvalid(
  {
    ...validManifest,
    triggers: [{ on: "timer", everyMinutes: 4, actions: [] }],
  },
  "invalid_timer_interval",
);
assertInvalid(
  {
    ...validManifest,
    triggers: [{ on: "timer", everyMinutes: { config: "intervalMinutes", extra: true }, actions: [] }],
  },
  "invalid_timer_interval",
);

assertInvalid(
  {
    ...validManifest,
    permissions: ["pet:speak", "pet:reaction"],
  },
  "missing_permission",
);

assertInvalid(
  {
    ...validManifest,
    permissions: ["timer", "pet:reaction"],
  },
  "missing_permission",
);

assertInvalid(
  {
    ...validManifest,
    permissions: ["timer", "pet:speak"],
  },
  "missing_permission",
);

function assertValid(manifest: unknown): void {
  const result = validatePluginManifest(manifest);
  if (!result.ok) throw new Error(`Expected valid manifest, got ${JSON.stringify(result.errors)}`);
}

function assertInvalid(manifest: unknown, code: string): void {
  const result = validatePluginManifest(manifest);
  assertEqual(result.ok, false, `Expected invalid manifest for ${code}`);
  assertTrue(result.errors.some((error) => error.code === code), `Expected ${code}, got ${JSON.stringify(result.errors)}`);
}

function assertEqual(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
}

function assertTrue(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

console.log("Plugin manifest contract validation passed.");
