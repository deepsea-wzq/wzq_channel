import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { myWsPlugin } from "./src/channel.js";
import { setMyWsRuntime } from "./src/runtime.js";

const plugin = {
  id: "wzq-channel",
  name: "Wzq Channel",
  description: "通过 WebSocket 与自定义服务器通信的 OpenClaw channel 插件",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMyWsRuntime(api.runtime);
    api.registerChannel({ plugin: myWsPlugin as ChannelPlugin });
  },
};

export default plugin;
