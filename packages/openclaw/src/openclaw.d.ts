declare module "openclaw/plugin-sdk/plugin-entry" {
  interface OpenClawPluginApi {
    on(eventName: "model_call_started", handler: () => void): void;
    on(eventName: "before_tool_call", handler: () => void): void;
  }

  export function definePluginEntry(options: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly register: (api: OpenClawPluginApi) => void;
  }): unknown;
}
