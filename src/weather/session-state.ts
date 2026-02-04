import type { DingtalkPlace } from "./subscription/types.js";

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
  userId?: string;
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

export function rememberDingtalkUserForSession(params: { sessionKey: string; userId: string }) {
  const sessionKey = params.sessionKey.trim();
  const userId = params.userId.trim();
  if (!sessionKey || !userId) return;

  const now = Date.now();
  sweep(now);
  const existing = sessions.get(sessionKey);
  sessions.set(sessionKey, {
    ...existing,
    userId,
    lastSeenAt: now,
  });
}

export function resolveDingtalkUserId(params: { sessionKey?: string }): string | null {
  const sessionKey = params.sessionKey?.trim() || "";
  if (!sessionKey) return null;

  const now = Date.now();
  sweep(now);
  const existing = sessions.get(sessionKey);
  if (!existing?.userId) return null;
  existing.lastSeenAt = now;
  return existing.userId;
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
