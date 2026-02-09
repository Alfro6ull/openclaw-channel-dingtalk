import { formatZonedYmdHm, getZonedParts } from "../time/zoned.js";
import { readDingtalkReminderStore, writeDingtalkReminderStore } from "./store.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

type DingtalkOpenApiLike = {
  sendTextToUser: (params: { userId: string; text: string }) => Promise<void>;
};

function isDue(params: { nowMs: number; scheduledAtMs: number; maxOverdueMs: number }): boolean {
  if (params.nowMs < params.scheduledAtMs) return false;
  if (params.nowMs - params.scheduledAtMs > params.maxOverdueMs) return false;
  return true;
}

export function startDingtalkReminderScheduler(params: {
  accountId: string;
  tickSeconds?: number;
  openApi: DingtalkOpenApiLike;
  abortSignal: AbortSignal;
  log?: LogLike;
}): void {
  const tickMs = Math.max(10, Math.floor((params.tickSeconds ?? 30) * 1000));
  const maxOverdueMs = 60 * 60 * 1000; // 1h 内的逾期提醒仍然发送

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const store = await readDingtalkReminderStore({ accountId: params.accountId });
      const reminders = Object.values(store.reminders).filter((r) => !r.sentAtMs && !r.canceledAtMs);
      if (reminders.length === 0) return;

      const nowMs = Date.now();
      let changed = false;

      for (const r of reminders) {
        if (!isDue({ nowMs, scheduledAtMs: r.scheduledAtMs, maxOverdueMs })) continue;
        try {
          const local = formatZonedYmdHm(r.scheduledAtMs, r.timeZone);
          const text = [
            `提醒（${local}）`,
            r.text || "时间到啦～",
            "",
            `你可以回复：完成 / 延后10分钟 / 取消（或带上 id=${r.id}）`,
          ]
            .join("\n")
            .slice(0, 3500);
          await params.openApi.sendTextToUser({ userId: r.userId, text });
          store.reminders[r.id] = { ...r, sentAtMs: nowMs };
          store.lastSentReminderIdByUser[r.userId] = r.id;
          changed = true;
        } catch (err: any) {
          params.log?.warn?.(`[dingtalk] reminder push failed (id=${r.id} user=${r.userId}): ${String(err?.message ?? err)}`);
        }
      }

      // 清理已发送/已取消且过期的记录，避免文件无限增长
      if (changed) {
        const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000; // 7 天前的历史直接丢弃
        for (const [id, r] of Object.entries(store.reminders)) {
          const doneAt = r.sentAtMs ?? r.canceledAtMs ?? 0;
          if (doneAt && doneAt < cutoff) {
            delete store.reminders[id];
          }
        }
        await writeDingtalkReminderStore({ store, accountId: params.accountId });
      }

      // 另外：如果最早的提醒已过期很久，也顺便清理
      const oldest = reminders.reduce((min, x) => Math.min(min, x.scheduledAtMs), Number.POSITIVE_INFINITY);
      if (Number.isFinite(oldest) && nowMs - oldest > 30 * 24 * 60 * 60 * 1000) {
        const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
        for (const [id, r] of Object.entries(store.reminders)) {
          const doneAt = r.sentAtMs ?? r.canceledAtMs ?? 0;
          if (doneAt && doneAt < cutoff) delete store.reminders[id];
        }
        await writeDingtalkReminderStore({ store, accountId: params.accountId });
      }

      // 触发一次 sweep（无副作用）：避免 getZonedParts 被 tree-shaking 误判未使用（某些构建器会这样）
      void getZonedParts;
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
