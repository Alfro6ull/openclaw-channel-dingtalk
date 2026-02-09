import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";

import { DingtalkOpenApiClient } from "../dingtalk/openapi.js";
import { resolveDingtalkUserId } from "../session/user.js";
import { formatZonedYmdHm } from "../time/zoned.js";
import { getCalendarWatch, upsertCalendarWatch } from "./store.js";
import type { DingtalkCalendarWatch } from "./types.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

function normalizeAccountId(accountId: unknown): string | undefined {
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function pickUserId(toolCtx: OpenClawPluginToolContext, params: Record<string, unknown>): string | null {
  const explicit = typeof params.userId === "string" ? params.userId.trim() : "";
  if (explicit) return explicit;
  return resolveDingtalkUserId({ sessionKey: toolCtx.sessionKey });
}

function toolText(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function pickPrimaryCalendarId(calendars: Array<{ calendarId: string; calendarType?: string }>): string | null {
  const primary =
    calendars.find((c) => String(c.calendarType || "").toLowerCase() === "primary") ??
    calendars.find((c) => c.calendarId) ??
    null;
  return primary?.calendarId?.trim() || null;
}

function eventStartMs(event: { start?: { dateTime?: string } }): number | null {
  const dt = event.start?.dateTime;
  if (!dt) return null;
  const ms = Date.parse(dt);
  return Number.isFinite(ms) ? ms : null;
}

export function createDingtalkCalendarToolsFactory(params: {
  log?: LogLike;
  defaultTimeZone?: string;
}) {
  return (toolCtx: OpenClawPluginToolContext): AnyAgentTool[] => {
    const accountId = normalizeAccountId(toolCtx.agentAccountId);
    const defaultTimeZone = (params.defaultTimeZone || "Asia/Shanghai").trim();
    const tools: AnyAgentTool[] = [];

    tools.push({
      name: "dingtalk_calendar_watch",
      label: "会议提醒开关",
      description: "开启/关闭会议提醒（会在会议开始前 N 分钟主动提醒）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["enabled"],
        properties: {
          enabled: { type: "boolean", description: "true=开启；false=关闭。" },
          minutesBefore: { type: "integer", minimum: 1, maximum: 180, description: "会前多少分钟提醒（默认10）。" },
          timeZone: { type: "string", description: "展示时间用的时区（默认 Asia/Shanghai）。" },
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, obj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const enabled = Boolean(obj.enabled);
        const minutesBeforeRaw = obj.minutesBefore;
        const minutesBefore =
          typeof minutesBeforeRaw === "number" && Number.isInteger(minutesBeforeRaw)
            ? minutesBeforeRaw
            : typeof minutesBeforeRaw === "string" && minutesBeforeRaw.trim()
              ? Number(minutesBeforeRaw.trim())
              : 10;
        const normalizedMinutes = Number.isInteger(minutesBefore) ? Math.max(1, Math.min(180, minutesBefore)) : 10;

        const timeZone =
          (typeof obj.timeZone === "string" && obj.timeZone.trim()) ? obj.timeZone.trim() : defaultTimeZone;

        const nowMs = Date.now();
        const existing = await getCalendarWatch({ userId, accountId });
        const watch: DingtalkCalendarWatch = {
          userId,
          enabled,
          minutesBefore: normalizedMinutes,
          timeZone,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        };
        await upsertCalendarWatch({ watch, accountId });

        return toolText(
          enabled
            ? `好的～会议提醒已开启：我会在会议开始前 ${watch.minutesBefore} 分钟提醒你。`
            : "好的，会议提醒已关闭。",
          { ok: true, watch }
        );
      },
    });

    tools.push({
      name: "dingtalk_calendar_today",
      label: "今日日程",
      description: "查看今天接下来几条日程（用于确认日历读取是否正常）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
          timeZone: { type: "string", description: "展示时间用的时区（默认 Asia/Shanghai）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, obj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });
        const timeZone =
          (typeof obj.timeZone === "string" && obj.timeZone.trim()) ? obj.timeZone.trim() : defaultTimeZone;

        const cfg = (toolCtx as any)?.config?.channels?.dingtalk ?? {};
        const clientId = String(cfg.clientId || cfg.appKey || "").trim();
        const clientSecret = String(cfg.clientSecret || cfg.appSecret || "").trim();
        if (!clientId || !clientSecret) {
          return toolText("还没配置钉钉 clientId/clientSecret，无法读取日程。", { ok: false });
        }
        const robotCode = String(cfg.robotCode || clientId).trim();
        const openApi = new DingtalkOpenApiClient({ clientId, clientSecret, robotCode, log: params.log });

        const calendars = await openApi.listCalendars({ userId });
        const calendarId = pickPrimaryCalendarId(calendars.calendars);
        if (!calendarId) return toolText("我没取到你的日历列表（可能没有开通日历权限/或账号不支持）。", { ok: false });

        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);
        const view = await openApi.listEventsView({
          userId,
          calendarId,
          timeMin: startOfDay.toISOString(),
          timeMax: endOfDay.toISOString(),
          maxResults: 50,
        });

        const upcoming = view.events
          .map((e) => {
            if (e.isAllDay) return null;
            const startMs = eventStartMs(e);
            if (startMs === null) return null;
            return { startMs, summary: (e.summary || "日程").trim(), location: e.location?.displayName?.trim() || "" };
          })
          .filter((x): x is { startMs: number; summary: string; location: string } => Boolean(x))
          .filter((x) => x.startMs >= Date.now() - 5 * 60_000)
          .sort((a, b) => a.startMs - b.startMs)
          .slice(0, 8);

        if (upcoming.length === 0) return toolText("今天接下来没有日程（或我没读到）。", { ok: true, events: [] });

        const lines = upcoming.map((e, i) => {
          const when = formatZonedYmdHm(e.startMs, timeZone);
          const where = e.location ? `（${e.location}）` : "";
          return `${i + 1}) ${when}：${e.summary}${where}`;
        });

        return toolText(`你今天的日程（接下来）：\n${lines.join("\n")}`, { ok: true, events: upcoming });
      },
    });

    params.log?.info?.(`[dingtalk] calendar tools registered (sessionKey=${toolCtx.sessionKey ?? "(none)"})`);
    return tools;
  };
}
