import crypto from "node:crypto";

import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";

import { resolveDingtalkUserId } from "../session/user.js";
import { addDaysToYmd, formatZonedYmdHm, getZonedParts, zonedLocalToUtcMs } from "../time/zoned.js";
import { parseReminderFromText } from "./nlp.js";
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
      description: "创建一次性提醒（例如：四点四十叫我一下 / 18:00 提醒我下班）。默认按 Asia/Shanghai 解释时间。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", description: "用户的原始提醒口令（建议直接传原句）。" },
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
          timeZone: { type: "string", description: "时区（可选，默认 Asia/Shanghai）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const obj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, obj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const raw = typeof obj.text === "string" ? obj.text.trim() : "";
        if (!raw) return toolText("请告诉我你想什么时候提醒（例如：16:40 叫我一下）。", { ok: false });

        const timeZone = (typeof obj.timeZone === "string" && obj.timeZone.trim()) ? obj.timeZone.trim() : defaultTimeZone;
        const parsed = parseReminderFromText(raw);
        if (parsed.kind === "multiple_times") {
          return toolText("我在一句话里识别到了多个时间点。为了避免歧义，请只说一个时间，例如：16:40 提醒我下班。", {
            ok: false,
            reason: "multiple_times",
          });
        }
        if (parsed.kind === "need_time") {
          const hint = parsed.message ? `要提醒的内容我先记为「${parsed.message}」。` : "";
          return toolText(
            [hint, "还差时间：请告诉我几点几分，例如：16:40 / 4点半 / 下午六点。"].filter(Boolean).join("\n"),
            { ok: false, reason: "need_time" }
          );
        }

        const now = new Date();
        const nowParts = getZonedParts(now, timeZone);
        const baseYmd = addDaysToYmd(nowParts, parsed.dayOffset);
        const desired = {
          timeZone,
          year: baseYmd.year,
          month: baseYmd.month,
          day: baseYmd.day,
          hour: pad2(parsed.hour),
          minute: pad2(parsed.minute),
          second: "00",
        };

        // 如果用户没说“明天/后天”，且目标时间已过，则顺延到下一天。
        const nowMinutes = Number(nowParts.hour) * 60 + Number(nowParts.minute);
        const targetMinutes = parsed.hour * 60 + parsed.minute;
        const shouldRollToNextDay = parsed.dayOffset === 0 && targetMinutes < nowMinutes;
        if (shouldRollToNextDay) {
          const rolled = addDaysToYmd(baseYmd, 1);
          desired.year = rolled.year;
          desired.month = rolled.month;
          desired.day = rolled.day;
        }

        const scheduledAtMs = zonedLocalToUtcMs(desired);
        const localLabel = formatZonedYmdHm(scheduledAtMs, timeZone);
        const message = parsed.message || "提醒你一下";

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
