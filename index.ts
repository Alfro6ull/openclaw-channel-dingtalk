import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { dingtalkPlugin } from "./src/channel.js";
import { setDingtalkRuntime } from "./src/runtime.js";
import { createDingtalkWeatherToolsFactory } from "./src/skills/weather/index.js";

const plugin = {
  id: "dingtalk",
  name: "DingTalk",
  description: "DingTalk channel plugin (skeleton)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 把 OpenClaw core 的部分能力暴露给 channel 实现使用（通过 runtime 注入）。
    setDingtalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
    api.registerTool(createDingtalkWeatherToolsFactory({ log: api.logger }));
  },
};

export default plugin;
