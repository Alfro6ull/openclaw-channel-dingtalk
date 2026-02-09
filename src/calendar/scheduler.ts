import { formatZonedYmdHm } from "../time/zoned.js";
import {
  getPrimaryCalendarId,
  listEnabledWatches,
  markEventNotified,
  rememberPrimaryCalendarId,
  wasEventNotified,
} from "./store.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

type CalendarLike = {
  listCalendars: (params: { userId: string }) => Promise<{ calendars: Array<{ calendarId: string; calendarType?: string; timeZone?: string }> }>;
  listEventsView: (params: {
    userId: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    nextToken?: string;
    maxResults?: number;
  }) => Promise<{
    events: Array<{
      id?: string;
      summary?: string;
      start?: { dateTime?: string; timeZone?: string };
      end?: { dateTime?: string; timeZone?: string };
      isAllDay?: boolean;
      location?: { displayName?: string };
    }>;
    nextToken?: string;
  }>;
  sendTextToUser: (params: { userId: string; text: string }) => Promise<void>;
};

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

export function startDingtalkCalendarReminderScheduler(params: {
  accountId: string;
  tickSeconds?: number;
  openApi: CalendarLike;
  abortSignal: AbortSignal;
  log?: LogLike;
  windowHours?: number;
}): void {
  const tickMs = Math.max(30, Math.floor((params.tickSeconds ?? 300) * 1000));
  const windowHours = Math.max(1, Math.min(168, params.windowHours ?? 24));

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const watches = await listEnabledWatches({ accountId: params.accountId });
      if (watches.length === 0) return;

      const nowMs = Date.now();
      const timeMin = new Date(nowMs - 5 * 60_000).toISOString();
      const timeMax = new Date(nowMs + windowHours * 60 * 60_000).toISOString();

      for (const w of watches) {
        try {
          const cachedCalendarId = await getPrimaryCalendarId({ userId: w.userId, accountId: params.accountId });
          let calendarId = cachedCalendarId;
          if (!calendarId) {
            const list = await params.openApi.listCalendars({ userId: w.userId });
            calendarId = pickPrimaryCalendarId(list.calendars);
            if (calendarId) {
              await rememberPrimaryCalendarId({ userId: w.userId, calendarId, accountId: params.accountId });
            }
          }
          if (!calendarId) continue;

          let nextToken: string | undefined = undefined;
          let page = 0;
          do {
            page += 1;
            const view = await params.openApi.listEventsView({
              userId: w.userId,
              calendarId,
              timeMin,
              timeMax,
              nextToken,
              maxResults: 50,
            });
            nextToken = view.nextToken;

            for (const e of view.events) {
              if (e.isAllDay) continue;
              const startMs = eventStartMs(e);
              if (startMs === null) continue;
              const deltaMs = startMs - nowMs;
              if (deltaMs < 0) continue;
              if (deltaMs > w.minutesBefore * 60_000) continue;

              const key = `${String(e.id || "")}|${String(e.start?.dateTime || "")}`;
              if (!key.trim()) continue;
              const already = await wasEventNotified({ userId: w.userId, key, accountId: params.accountId });
              if (already) continue;

              const summary = (e.summary || "会议").trim();
              const local = formatZonedYmdHm(startMs, w.timeZone);
              const mins = Math.max(0, Math.round(deltaMs / 60_000));
              const where = e.location?.displayName?.trim() ? `地点：${e.location.displayName.trim()}` : "";

              const text = [
                `会议提醒：${summary}`,
                `开始时间：${local}（${w.timeZone}）`,
                mins > 0 ? `还有 ${mins} 分钟` : "即将开始",
                where,
              ]
                .filter(Boolean)
                .join("\n")
                .slice(0, 3500);

              await params.openApi.sendTextToUser({ userId: w.userId, text });
              await markEventNotified({ userId: w.userId, key, accountId: params.accountId });
            }

            if (!nextToken) break;
          } while (nextToken && page < 5);
        } catch (err: any) {
          params.log?.warn?.(`[dingtalk] calendar reminder poll failed (user=${w.userId}): ${String(err?.message ?? err)}`);
        }
      }
    } finally {
      running = false;
    }
  }, tickMs);

  params.abortSignal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
    },
    { once: true }
  );
}

