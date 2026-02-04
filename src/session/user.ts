// 会话级别的“用户身份”缓存：用于在 tools 层推断 userId。
// 注意：这里只做短期内存缓存，不做持久化。

type SessionRecord = {
  userId?: string;
  lastSeenAt: number;
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

