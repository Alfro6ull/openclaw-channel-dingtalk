import { readDingtalkSubscriptionStore, writeDingtalkSubscriptionStore } from "./subscription-store.js";
import { fetchForecast, formatForecastSummaryText } from "./open-meteo.js";
import type { DingtalkOpenApiClient } from "./dingtalk-openapi.js";
import type { DingtalkWeatherSubscription } from "./subscription-types.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
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

function isValidTimeZone(timeZone: string): boolean {
  try {
    
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function getZonedParts(date: Date, timeZone: string): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }
  return {
    year: lookup.year ?? "1970",
    month: lookup.month ?? "01",
    day: lookup.day ?? "01",
    hour: lookup.hour ?? "00",
    minute: lookup.minute ?? "00",
  };
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
  openApi: DingtalkOpenApiClient;
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
