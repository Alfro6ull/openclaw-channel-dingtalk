import { readDingtalkSubscriptionStore, writeDingtalkSubscriptionStore } from "./store.js";
import { fetchForecast, formatForecastSummaryText } from "../weather/open-meteo.js";
import type { DingtalkWeatherSubscription } from "./types.js";
import { getZonedParts } from "../time/zoned.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

type DingtalkOpenApiLike = {
  sendTextToUser: (params: { userId: string; text: string }) => Promise<void>;
};

function parseHHmm(time: string): { hour: number; minute: number } | null {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function computeLocalDateKey(parts: { year: string; month: string; day: string }): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function computeMinutesOfDay(parts: { hour: string; minute: string }): number {
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isDueNow(params: {
  subscription: DingtalkWeatherSubscription;
  localDateKey: string;
  nowMinutes: number;
  graceMinutes?: number;
}): boolean {
  const sub = params.subscription;
  if (sub.lastSentLocalDate === params.localDateKey) return false;

  const parsed = parseHHmm(sub.schedule.time);
  if (!parsed) return false;
  const target = parsed.hour * 60 + parsed.minute;
  const grace = params.graceMinutes ?? 2;
  return params.nowMinutes >= target && params.nowMinutes <= target + grace;
}

export function startDingtalkWeatherSubscriptionScheduler(params: {
  accountId: string;
  tickSeconds?: number;
  openApi: DingtalkOpenApiLike;
  abortSignal: AbortSignal;
  log?: LogLike;
}): void {
  const tickMs = Math.max(10, Math.floor((params.tickSeconds ?? 60) * 1000));

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const store = await readDingtalkSubscriptionStore({ accountId: params.accountId });
      const entries = Object.entries(store.subscriptions);
      if (entries.length === 0) return;

      let changed = false;

      for (const [userId, sub] of entries) {
        try {
          const parts = getZonedParts(new Date(), sub.place.timezone);
          const localDateKey = computeLocalDateKey(parts);
          const nowMinutes = computeMinutesOfDay(parts);
          if (!isDueNow({ subscription: sub, localDateKey, nowMinutes })) continue;

          const forecast = await fetchForecast({ place: sub.place });
          const text = formatForecastSummaryText({ place: sub.place, forecast, title: "天气推送" });
          await params.openApi.sendTextToUser({ userId, text });

          store.subscriptions[userId] = {
            ...sub,
            updatedAt: Date.now(),
            lastSentLocalDate: localDateKey,
          };
          changed = true;
        } catch (err: any) {
          params.log?.warn?.(`[dingtalk] subscription push failed (user=${userId}): ${String(err?.message ?? err)}`);
        }
      }

      if (changed) {
        await writeDingtalkSubscriptionStore({ store, accountId: params.accountId });
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
