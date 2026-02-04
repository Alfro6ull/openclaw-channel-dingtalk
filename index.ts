import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { dingtalkPlugin } from "./src/channel.js";
import { setDingtalkRuntime } from "./src/runtime.js";
import { createDingtalkWeatherToolsFactory } from "./src/weather/index.js";

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

    // 不污染用户消息：在 agent 启动前注入一段“如何用工具完成任务”的上下文提示。
    // 这类提示属于系统/上下文层，而不是用户输入。
    api.on?.("before_agent_start", async (_event: any, ctx: any) => {
      const provider = String(ctx?.messageProvider ?? ctx?.channel ?? "").trim().toLowerCase();
      if (provider !== "dingtalk") return;
      return {
        prependContext: [
          "你正在钉钉对话中与用户交流，请用自然、简洁的中文回复。",
          "当用户询问天气/天气预览时，请优先调用工具获取真实数据，而不是凭记忆回答。",
          "当工具返回 status=need_user_choice（地点存在歧义）时：把 choices 列表展示给用户并询问编号；等待用户选择后再继续（不要代替用户选择）。",
        ].join("\n"),
      };
    });
  },
};

export default plugin;
