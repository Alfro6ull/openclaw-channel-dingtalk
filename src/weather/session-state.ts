import type { DingtalkPlace } from "./types.js";

export type WeatherPendingAction =
  | { kind: "now" }
  | { kind: "details" }
  | { kind: "subscribe"; timeHHmm: string };

export type WeatherPendingSelection = {
  places: DingtalkPlace[];
  action: WeatherPendingAction;
  createdAt: number;
};

type SessionRecord = {
  lastSeenAt: number;
  weatherPending?: WeatherPendingSelection;
};

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const sessions = new Map<string, SessionRecord>();

function sweep(now: number) {
  for (const [key, value] of sessions.entries()) {
    if (now - value.lastSeenAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

export function setWeatherPendingSelection(params: {
  sessionKey?: string;
  places: DingtalkPlace[];
  action: WeatherPendingAction;
}) {
  const sessionKey = params.sessionKey?.trim() || "";
  if (!sessionKey) return;

  const now = Date.now();
  sweep(now);
  const existing = sessions.get(sessionKey);
  sessions.set(sessionKey, {
    ...existing,
    lastSeenAt: now,
    weatherPending: {
      places: params.places,
      action: params.action,
      createdAt: now,
    },
  });
}

export function peekWeatherPendingSelection(params: { sessionKey?: string }): WeatherPendingSelection | null {
  const sessionKey = params.sessionKey?.trim() || "";
  if (!sessionKey) return null;

  const now = Date.now();
  sweep(now);
  const existing = sessions.get(sessionKey);
  if (!existing?.weatherPending) return null;
  existing.lastSeenAt = now;
  return existing.weatherPending;
}

export function clearWeatherPendingSelection(params: { sessionKey?: string }) {
  const sessionKey = params.sessionKey?.trim() || "";
  if (!sessionKey) return;

  const now = Date.now();
  sweep(now);
  const existing = sessions.get(sessionKey);
  if (!existing) return;
  sessions.set(sessionKey, { ...existing, lastSeenAt: now, weatherPending: undefined });
}
