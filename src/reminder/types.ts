// 一次性提醒（闹钟）相关类型定义。

export type DingtalkReminder = {
  id: string;
  userId: string;
  /** 提醒内容（发送给用户的文本主体）。 */
  text: string;
  /** 触发时间（UTC 毫秒时间戳）。 */
  scheduledAtMs: number;
  /** 解释时间用的时区（默认 Asia/Shanghai）。 */
  timeZone: string;
  createdAtMs: number;
  sentAtMs?: number;
  canceledAtMs?: number;
};

export type DingtalkReminderStoreV1 = {
  version: 1;
  reminders: Record<string, DingtalkReminder>;
};

