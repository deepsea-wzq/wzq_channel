import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setMyWsRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getMyWsRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("wzq-channel runtime 未初始化");
  }
  return runtime;
}
