import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import axios from "axios";

import type { DingtalkConfig, ResolvedDingtalkAccount } from "./types.js";
import { DingtalkOpenApiClient } from "./dingtalk/openapi.js";
import { getDingtalkRuntime } from "./runtime.js";
import {
  createDingtalkWeatherToolsFactory,
  startDingtalkWeatherSubscriptionScheduler,
} from "./weather/index.js";
import { rememberDingtalkUserForSession } from "./session/user.js";
import { peekWeatherPendingSelection } from "./weather/session-state.js";
import { createDingtalkReminderToolsFactory, startDingtalkReminderScheduler } from "./reminder/index.js";

const meta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉)",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "DingTalk enterprise messaging (skeleton plugin).",
  aliases: ["ding"],
  order: 80,
} as const;

function resolveDingtalkConfig(cfg: OpenClawConfig): DingtalkConfig {
  const raw = (cfg.channels as Record<string, unknown> | undefined)?.dingtalk;
  return (raw ?? {}) as DingtalkConfig;
}

function resolveDingtalkAccount(cfg: OpenClawConfig): ResolvedDingtalkAccount {
  const config = resolveDingtalkConfig(cfg);
  const enabled = Boolean(config.enabled);
  const clientId = config.clientId?.trim() || config.appKey?.trim() || "";
  const clientSecret = config.clientSecret?.trim() || config.appSecret?.trim() || "";
  const configured = Boolean(clientId && clientSecret);
  return { accountId: DEFAULT_ACCOUNT_ID, enabled, configured, config };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseSelectionIndex(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 仅接受两种形式：
  // 1) "2"
  // 2) "2) 成都 · 四川 · 中国" / "2）成都..."
  const m = trimmed.match(/^(\d{1,2})\s*$/) ?? trimmed.match(/^(\d{1,2})\s*[)）]\s*.+$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 10) return null;
  return n;
}

function looksLikeReminderCommand(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  // 天气相关交给 weather 处理，别误触发提醒。
  if (/(天气|温度|几度|下雨|雨吗|湿度|风|紫外线|预报|详情)/.test(t)) return false;

  // 关键词 + “看起来像时间”的线索（点/冒号/下午等）。
  const hasReminderKeyword = /(提醒|叫我|闹钟|下班)/.test(t);
  const hasTimeClue = /(\d{1,2}\s*:\s*\d{1,2})|点|凌晨|早上|上午|中午|下午|晚上|傍晚|夜里/.test(t);
  return hasReminderKeyword && hasTimeClue;
}

function sanitizeAgentReply(text: string): string {
  const t = text.trim();
  if (!t) return text;
  if (/Unexpected end of JSON input/.test(t) || /after property value in JSON/.test(t) || /Expected .* in JSON/.test(t)) {
    return (
      "我刚才没把你的意思解析清楚。\n" +
      "你可以这样说：\n" +
      "- 成都天气 / 成都天气详情\n" +
      "- 四点四十叫我一下 / 18:00 提醒我下班\n" +
      "- 订阅 成都 10:20（每天推送天气）"
    );
  }
  return text;
}

type StreamCallback = {
  headers?: { messageId?: string };
  data: string;
};

type InboundRobotMessage = {
  // 钉钉推送机器人消息时，通常会带上这个用于“会话内回复”的 webhook URL。
  sessionWebhook?: string;
  msgtype?: string;
  text?: { content?: string };
  // 可选元信息（会随钉钉推送类型 / SDK 版本变化）。
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  conversationId?: string;
  msgId?: string;
};

async function replyViaSessionWebhook(params: { sessionWebhook: string; text: string }) {
  // DingTalk 的 sessionWebhook 接受一个 webhook 风格的 payload。
  // 这里保持最小化：只回纯文本。
  await axios.post(params.sessionWebhook, { msgtype: "text", text: { content: params.text } });
}

function maskSessionWebhook(url: string | undefined): string {
  if (!url) return "(none)";
  // 避免把完整 webhook URL 打进日志（里面可能包含 token）。
  const head = url.slice(0, 24);
  const tail = url.slice(-8);
  return `${head}...${tail}`;
}

export const dingtalkPlugin: ChannelPlugin<ResolvedDingtalkAccount> = {
  id: "dingtalk",
  meta,
  capabilities: {
    chatTypes: ["direct", "channel"],
    media: false,
    reactions: false,
    threads: true,
    reply: true,
    edit: false,
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  // 最小 schema：让 `channels.dingtalk.*` 能通过严格配置校验。
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        appKey: { type: "string" },
        appSecret: { type: "string" },
        robotCode: { type: "string" },
        debug: { type: "boolean" },
        subscription: {
          type: "object",
          additionalProperties: false,
          properties: {
            tickSeconds: { type: "integer", minimum: 10, maximum: 3600 },
          },
        },
        reminder: {
          type: "object",
          additionalProperties: false,
          properties: {
            tickSeconds: { type: "integer", minimum: 10, maximum: 3600 },
            defaultTimezone: { type: "string" },
          },
        },
        connectionMode: { type: "string", enum: ["stream", "webhook"] },
        webhookPath: { type: "string" },
        webhookPort: { type: "integer", minimum: 1 },
      },
    },
    uiHints: {
      "channels.dingtalk.clientSecret": { sensitive: true, placeholder: "keep this secret" },
      "channels.dingtalk.appSecret": { sensitive: true, placeholder: "legacy alias of clientSecret" },
    },
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveDingtalkAccount(cfg),
  },
  pairing: {
    idLabel: "dingtalkUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(dingtalk|ding|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      // 占位：等实现“主动发消息”后，可以给 `id` 发一条私聊通知。
      // 现在先不抛错，保证 pairing 在 config/doctor 等流程里能正常走完。
      void cfg;
      void id;
      void PAIRING_APPROVED_MESSAGE;
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const config = ctx.account.config;
      const clientId = config.clientId?.trim() || config.appKey?.trim();
      const clientSecret = config.clientSecret?.trim() || config.appSecret?.trim();
      if (!clientId || !clientSecret) {
        throw new Error("DingTalk clientId/clientSecret are required (set channels.dingtalk.clientId/clientSecret).");
      }

      // 用于 OpenAPI 的“机器人发消息”接口。
      // 很多企业内部应用的 appKey 和 robotCode 值相同，但这里仍然保持可配置。
      const robotCode = config.robotCode?.trim() || clientId;
      const subscriptionTickSeconds = config.subscription?.tickSeconds;
      const reminderTickSeconds = config.reminder?.tickSeconds ?? subscriptionTickSeconds;
      const reminderDefaultTimezone = config.reminder?.defaultTimezone?.trim() || "Asia/Shanghai";

      // 启动订阅调度器（尽力而为）。如果缺少 robotCode，则保留聊天能力，但禁用订阅推送。
      if (robotCode) {
        const openApi = new DingtalkOpenApiClient({
          clientId,
          clientSecret,
          robotCode,
          log: ctx.log,
        });
        startDingtalkWeatherSubscriptionScheduler({
          accountId: ctx.account.accountId,
          tickSeconds: subscriptionTickSeconds,
          openApi,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });

        startDingtalkReminderScheduler({
          accountId: ctx.account.accountId,
          tickSeconds: reminderTickSeconds,
          openApi,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      } else {
        ctx.log?.warn?.("[dingtalk] robotCode not configured; weather subscriptions will be disabled.");
      }

      ctx.log?.info?.("[dingtalk] starting DingTalk Stream client...");

      // Stream SDK 客户端：主动连到钉钉（无需自建公网 webhook）。
      const client = new DWClient({
        clientId,
        clientSecret,
        debug: Boolean(config.debug),
        keepAlive: true,
      } as any);

      client.registerCallbackListener(TOPIC_ROBOT, async (res: StreamCallback) => {
        const messageId = res.headers?.messageId;
        try {
          // 给钉钉回 ACK，避免重复推送/重试。
          if (messageId) client.socketCallBackResponse?.(messageId, { success: true });

          const msg = JSON.parse(res.data) as InboundRobotMessage;
          const sessionWebhook = msg.sessionWebhook;

          const text = msg.msgtype === "text" ? msg.text?.content?.trim() : "";

          ctx.log?.info?.(
            `[dingtalk] inbound msgtype=${msg.msgtype ?? "unknown"} text=${JSON.stringify(text)} ` +
              `senderStaffId=${msg.senderStaffId ?? "(none)"} senderId=${msg.senderId ?? "(none)"} ` +
              `conversationId=${msg.conversationId ?? "(none)"} msgId=${msg.msgId ?? "(none)"} ` +
              `sessionWebhook=${maskSessionWebhook(sessionWebhook)}`
          );

          if (!sessionWebhook) {
            ctx.log?.warn?.("[dingtalk] inbound message missing sessionWebhook; cannot reply.");
            return;
          }

          const core = getDingtalkRuntime();
          const cfg = ctx.cfg as OpenClawConfig;

          // 基于“是谁在跟我们说话”创建 route（agent + sessionKey）。
          const conversationId = msg.conversationId?.trim() || "";
          const senderStaffId = msg.senderStaffId?.trim() || "";
          const senderId = msg.senderId?.trim() || "";

          // 真实会话标识：用于回消息/路由元信息。
          const deliveryTo = conversationId || senderStaffId || senderId || sessionWebhook;

          // 会话隔离键：尽量避免群聊里多人共用一个 session（数字选择/候选列表会串）。
          // 私聊也不受影响（同一个人 senderStaffId 固定）。
          const sessionPeerId =
            conversationId && senderStaffId ? `${conversationId}:${senderStaffId}` : deliveryTo;

          const route = core.channel.routing.resolveAgentRoute({
            cfg,
            channel: "dingtalk",
            accountId: ctx.account.accountId,
            peer: {
              kind: "direct",
              id: sessionPeerId,
            },
          });

          const rawBody = text || "(non-text message)";
          const body = core.channel.reply.formatAgentEnvelope({
            channel: "DingTalk",
            from: msg.senderNick || senderStaffId || senderId || "dingtalk-user",
            timestamp: Date.now(),
            envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
            // 不要把规则/提示词塞进用户消息；规则通过 before_agent_start hook 注入。
            body: rawBody,
          });

          // 记录 “sessionKey -> userId” 的映射，供 agent 工具推断订阅归属。
          const userId = senderStaffId || senderId || "";
          if (userId) {
            rememberDingtalkUserForSession({ sessionKey: route.sessionKey, userId });
          }

          // 提醒 fast-path：像“16:40 叫我一下”这种明确口令，直接创建提醒，避免模型误输出半截 JSON。
          if (text && looksLikeReminderCommand(text)) {
            try {
              const toolFactory = createDingtalkReminderToolsFactory({
                log: ctx.log,
                defaultTimeZone: reminderDefaultTimezone,
              });
              const tools = toolFactory({
                sessionKey: route.sessionKey,
                agentAccountId: route.accountId,
                messageChannel: "dingtalk",
                config: cfg,
                sandboxed: false,
              } as any);
              const createTool = tools.find((tool: any) => tool?.name === "dingtalk_reminder_create");
              if (createTool) {
                const result = await createTool.execute(`manual-${randomId()}`, { text }, ctx.abortSignal);
                const replyText = Array.isArray(result?.content)
                  ? result.content
                      .filter((x: any) => x?.type === "text" && typeof x?.text === "string")
                      .map((x: any) => String(x.text))
                      .join("\n")
                  : "";
                if (replyText.trim()) {
                  await replyViaSessionWebhook({ sessionWebhook, text: replyText });
                  return;
                }
              }
            } catch (err: any) {
              ctx.log?.warn?.(`[dingtalk] reminder fast-path failed: ${String(err?.message ?? err)}`);
            }
          }

          // 防呆：当用户只回复 “2” 或 “2) xxx” 且当前会话存在待选择的候选项时，
          // 直接执行 pick_place 工具，避免模型生成不完整 JSON 导致工具调用失败。
          const selectionIndex = typeof text === "string" ? parseSelectionIndex(text) : null;
          if (selectionIndex !== null) {
            const pending = peekWeatherPendingSelection({ sessionKey: route.sessionKey });
            if (pending) {
              try {
                const toolFactory = createDingtalkWeatherToolsFactory({ log: ctx.log });
                const tools = toolFactory({
                  sessionKey: route.sessionKey,
                  agentAccountId: route.accountId,
                  messageChannel: "dingtalk",
                  config: cfg,
                  sandboxed: false,
                } as any);
                const pickTool = tools.find((tool: any) => tool?.name === "dingtalk_weather_pick_place");
                if (pickTool) {
                  const result = await pickTool.execute(`manual-${randomId()}`, { index: selectionIndex }, ctx.abortSignal);
                  const replyText = Array.isArray(result?.content)
                    ? result.content
                        .filter((x: any) => x?.type === "text" && typeof x?.text === "string")
                        .map((x: any) => String(x.text))
                        .join("\n")
                    : "";
                  if (replyText.trim()) {
                    await replyViaSessionWebhook({ sessionWebhook, text: replyText });
                    return;
                  }
                }

                // 有 pending 但没能完成 pick_place：不要把“纯数字选择”丢给模型（容易触发半截 JSON 工具调用）。
                await replyViaSessionWebhook({
                  sessionWebhook,
                  text: `我收到了你的选择（${selectionIndex}），但我这边没有取到可选地点列表了。请重新发一次地点，例如：成都 / 上海浦东。`,
                });
                return;
              } catch (err: any) {
                ctx.log?.warn?.(
                  `[dingtalk] numeric selection fast-path failed: ${String(err?.message ?? err)}`
                );

                await replyViaSessionWebhook({
                  sessionWebhook,
                  text: `我收到了你的选择（${selectionIndex}），但处理时出错了。请重新发一次地点，例如：成都 / 上海浦东。`,
                });
                return;
              }
            }
          }

          const ctxPayload = core.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: rawBody,
            CommandBody: rawBody,
            From: `dingtalk:${senderStaffId || senderId || "unknown"}`,
            To: `dingtalk:${deliveryTo}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct",
            SenderName: msg.senderNick,
            SenderId: senderStaffId || senderId,
            Provider: "dingtalk",
            Surface: "dingtalk",
            MessageSid: msg.msgId || messageId || randomId(),
            Timestamp: Date.now(),
            OriginatingChannel: "dingtalk",
            OriginatingTo: `dingtalk:${deliveryTo}`,
            CommandAuthorized: true,
          });

          // core helper 会调用模型并产出回复（内部可能是流式 chunk）。
          // 这里为了稳定性，关闭 block-streaming：钉钉侧只收到一条最终回复。
          await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload) => {
                const raw = payload.markdown || payload.text || "";
                const replyText = sanitizeAgentReply(raw);
                if (!replyText.trim()) return;
                await replyViaSessionWebhook({ sessionWebhook, text: replyText });
              },
              onError: (err, info) => {
                ctx.log?.error?.(`[dingtalk] reply ${info.kind} failed: ${String(err)}`);
              },
            },
            replyOptions: {
              disableBlockStreaming: true,
            },
          });
        } catch (err: any) {
          ctx.log?.error?.(`[dingtalk] failed to handle inbound message: ${String(err?.message ?? err)}`);
        }
      });

      await client.connect();
      ctx.log?.info?.("[dingtalk] DingTalk Stream client connected.");

      await waitForAbort(ctx.abortSignal);

      // 尽力而为地停止；dingtalk-stream 的 API 可能随版本变化。
      try {
        client.disconnect?.();
      } catch {
      
      }
      return null;
    },
  },
};
