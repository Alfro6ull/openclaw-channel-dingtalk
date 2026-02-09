import crypto from "node:crypto";

import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";

import { resolveDingtalkUserId } from "../session/user.js";
import { addDaysToYmd, formatZonedYmdHm, getZonedParts, zonedLocalToUtcMs } from "../time/zoned.js";
import { addDingtalkReminder, cancelDingtalkReminder, listDingtalkReminders } from "./store.js";
import type { DingtalkReminder } from "./types.js";

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

function parseTimeHHmm(raw: string): { hour: number; minute: number } | null {
  const s = raw.trim();
  const m = s.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseYmd(raw: string): { year: string; month: string; day: string } | null {
  const s = raw.trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || year < 1970 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return { year: String(year), month: pad2(month), day: pad2(day) };
}

export function createDingtalkReminderToolsFactory(params: { log?: LogLike; defaultTimeZone?: string }) {
  return (toolCtx: OpenClawPluginToolContext): AnyAgentTool[] => {
    const configuredTimeZone =
      typeof (toolCtx as any)?.config?.channels?.dingtalk?.reminder?.defaultTimezone === "string"
        ? String((toolCtx as any).config.channels.dingtalk.reminder.defaultTimezone)
        : typeof (toolCtx as any)?.config?.channels?.dingtalk?.defaultTimezone === "string"
          ? String((toolCtx as any).config.channels.dingtalk.defaultTimezone)
          : "";
    const defaultTimeZone = (params.defaultTimeZone || configuredTimeZone || "Asia/Shanghai").trim();

    const accountId = normalizeAccountId(toolCtx.agentAccountId);
    const tools: AnyAgentTool[] = [];

    tools.push({
      name: "dingtalk_reminder_create",
      label: "创建提醒",
      description:
        "创建一次性提醒（由模型先理解用户意图并提取结构化时间）。默认按 Asia/Shanghai 解释时间。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["time"],
        properties: {
          time: { type: "string", description: "提醒时间（24小时制 HH:mm，例如：18:00 / 09:30）。" },
          dayOffset: {
            type: "integer",
            minimum: 0,
            maximum: 7,
            description: "相对今天的天数偏移（可选；0=今天，1=明天）。不填则默认 0（若时间已过则顺延到明天）。",
          },
          date: {
            type: "string",
            description: "指定日期（可选，格式 YYYY-MM-DD）。如果提供 date，将严格按该日期创建提醒。",
          },
          message: { type: "string", description: "提醒内容（可选，例如：下班 / 开会）。" },
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
          timeZone: { type: "string", description: "时区（可选，默认 Asia/Shanghai）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, obj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const timeRaw = typeof obj.time === "string" ? obj.time.trim() : "";
        if (!timeRaw) return toolText("还差时间：请告诉我提醒时间（24小时制 HH:mm，例如：18:00 / 09:30）。", { ok: false });
        const parsedTime = parseTimeHHmm(timeRaw);
        if (!parsedTime) {
          return toolText("时间格式不对：请用 24 小时制 HH:mm（例如：18:00 / 09:30）。", {
            ok: false,
            reason: "bad_time_format",
          });
        }

        const now = new Date();
        const timeZone = (typeof obj.timeZone === "string" && obj.timeZone.trim()) ? obj.timeZone.trim() : defaultTimeZone;
        const nowParts = getZonedParts(now, timeZone);

        const explicitDateRaw = typeof obj.date === "string" ? obj.date.trim() : "";
        const explicitDate = explicitDateRaw ? parseYmd(explicitDateRaw) : null;

        const dayOffsetRaw = obj.dayOffset;
        const dayOffset =
          typeof dayOffsetRaw === "number" && Number.isInteger(dayOffsetRaw)
            ? dayOffsetRaw
            : typeof dayOffsetRaw === "string" && dayOffsetRaw.trim()
              ? Number(dayOffsetRaw.trim())
              : null;

        if (dayOffset !== null && (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 7)) {
          return toolText("dayOffset 不合法：请使用 0～7 的整数（0=今天，1=明天）。", { ok: false, reason: "bad_day_offset" });
        }

        const baseYmd = explicitDate ?? addDaysToYmd(nowParts, dayOffset ?? 0);
        const desired = {
          timeZone,
          year: baseYmd.year,
          month: baseYmd.month,
          day: baseYmd.day,
          hour: pad2(parsedTime.hour),
          minute: pad2(parsedTime.minute),
          second: "00",
        };

        if (!explicitDate) {
          // 没有指定 date：如果目标时间已过，则顺延到下一天。
          const nowMinutes = Number(nowParts.hour) * 60 + Number(nowParts.minute);
          const targetMinutes = parsedTime.hour * 60 + parsedTime.minute;
          if (targetMinutes < nowMinutes) {
            const rolled = addDaysToYmd(baseYmd, 1);
            desired.year = rolled.year;
            desired.month = rolled.month;
            desired.day = rolled.day;
          }
        }

        const scheduledAtMs = zonedLocalToUtcMs(desired);
        if (explicitDate && scheduledAtMs < now.getTime() - 60_000) {
          return toolText(`这个时间已经过去了：${formatZonedYmdHm(scheduledAtMs, timeZone)}。请换一个未来的时间。`, {
            ok: false,
            reason: "time_in_past",
          });
        }
        const localLabel = formatZonedYmdHm(scheduledAtMs, timeZone);
        const message = (typeof obj.message === "string" && obj.message.trim()) ? obj.message.trim() : "提醒你一下";

        const reminder: DingtalkReminder = {
          id: crypto.randomUUID(),
          userId,
          text: message,
          scheduledAtMs,
          timeZone,
          createdAtMs: Date.now(),
        };
        await addDingtalkReminder({ reminder, accountId });

        return toolText(`好的～我会在 ${localLabel} 提醒你：${message}\n如需查看：发送“我的提醒”。如需取消：发送“取消提醒 ${reminder.id}”。`, {
          ok: true,
          reminder,
        });
      },
    });

    tools.push({
      name: "dingtalk_reminder_list",
      label: "我的提醒",
      description: "查看即将触发的提醒列表。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, obj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const reminders = await listDingtalkReminders({ userId, accountId });
        if (reminders.length === 0) return toolText("你目前没有待触发的提醒。", { ok: true, reminders: [] });

        const lines = reminders.slice(0, 10).map((r, i) => {
          const when = formatZonedYmdHm(r.scheduledAtMs, r.timeZone);
          return `${i + 1}) ${when}：${r.text}（id=${r.id}）`;
        });
        return toolText(`你的提醒：\n${lines.join("\n")}\n取消某条：发送“取消提醒 <id>”。`, { ok: true, reminders });
      },
    });

    tools.push({
      name: "dingtalk_reminder_cancel",
      label: "取消提醒",
      description: "取消一条提醒（需要提供 id）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "提醒 id（从“我的提醒”里获取）。" },
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, obj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const id = typeof obj.id === "string" ? obj.id.trim() : "";
        if (!id) return toolText("请提供要取消的提醒 id（从“我的提醒”里复制）。", { ok: false });

        const ok = await cancelDingtalkReminder({ id, userId, accountId });
        return toolText(ok ? "已取消提醒。" : "没找到这条提醒，可能已触发或已取消。", { ok: true, canceled: ok });
      },
    });

    params.log?.info?.(`[dingtalk] reminder tools registered (sessionKey=${toolCtx.sessionKey ?? "(none)"})`);
    return tools;
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
