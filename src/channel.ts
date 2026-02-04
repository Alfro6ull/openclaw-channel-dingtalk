import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import axios from "axios";

import type { DingtalkConfig, ResolvedDingtalkAccount } from "./types.js";
import { DingtalkOpenApiClient } from "./dingtalk-openapi.js";
import { getDingtalkRuntime } from "./runtime.js";
import { createDingtalkSubscriptionFlow } from "./subscription-flow.js";
import { startDingtalkWeatherSubscriptionScheduler } from "./subscription-scheduler.js";

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

      const subscriptionFlow = createDingtalkSubscriptionFlow({
        accountId: ctx.account.accountId,
        log: ctx.log,
      });

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

          // 订阅流程（本地处理）。若命中订阅指令，则不再交给模型处理。
          const userId = msg.senderStaffId?.trim() || "";
          if (typeof text === "string" && text.trim() && userId) {
            const result = await subscriptionFlow.handleMessage({ userId, text });
            if (result.handled) {
              await replyViaSessionWebhook({ sessionWebhook, text: result.reply });
              return;
            }
          }

          const core = getDingtalkRuntime();
          const cfg = ctx.cfg as OpenClawConfig;

          // 基于“是谁在跟我们说话”创建 route（agent + sessionKey）。
          const peerId =
            msg.conversationId?.trim() ||
            msg.senderStaffId?.trim() ||
            msg.senderId?.trim() ||
            sessionWebhook;

          const route = core.channel.routing.resolveAgentRoute({
            cfg,
            channel: "dingtalk",
            accountId: ctx.account.accountId,
            peer: {
              kind: "direct",
              id: peerId,
            },
          });

          const rawBody = text || "(non-text message)";
          const styleHint =
            "请用自然、简洁的中文回复（不要使用emoji）；不要编造未发生的对话或系统日志；不确定就直接说不知道。";
          const body = core.channel.reply.formatAgentEnvelope({
            channel: "DingTalk",
            from: msg.senderNick || msg.senderStaffId || msg.senderId || "dingtalk-user",
            timestamp: Date.now(),
            envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
            body: `${styleHint}\n\n${rawBody}`,
          });

          const ctxPayload = core.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: rawBody,
            CommandBody: rawBody,
            From: `dingtalk:${msg.senderStaffId || msg.senderId || "unknown"}`,
            To: `dingtalk:${peerId}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct",
            SenderName: msg.senderNick,
            SenderId: msg.senderStaffId || msg.senderId,
            Provider: "dingtalk",
            Surface: "dingtalk",
            MessageSid: msg.msgId || messageId || randomId(),
            Timestamp: Date.now(),
            OriginatingChannel: "dingtalk",
            OriginatingTo: `dingtalk:${peerId}`,
            CommandAuthorized: true,
          });

          // core helper 会调用模型并产出回复（内部可能是流式 chunk）。
          // 这里为了稳定性，关闭 block-streaming：钉钉侧只收到一条最终回复。
          await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload) => {
                const replyText = payload.markdown || payload.text || "";
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
