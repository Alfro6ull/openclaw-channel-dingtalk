import type { PluginRuntime } from "openclaw/plugin-sdk";

// OpenClaw 在启动插件时会注入一个 runtime 对象。
// 里面包含了一些对插件开放的核心能力（路由、回复分发、会话/状态存储等）。
// 缓存到这里，供其它文件（如 channel.ts）使用，避免循环依赖。
let runtime: PluginRuntime | null = null;

export function setDingtalkRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getDingtalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DingTalk runtime not initialized");
  }
  return runtime;
}
