// 一次性提醒（闹钟）相关类型定义。

export type DingtalkReminderAckAction = "done" | "snoozed" | "canceled";

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

  /** 用户回执时间（完成/延后/取消）。 */
  acknowledgedAtMs?: number;
  ackAction?: DingtalkReminderAckAction;

  /** 如果本条被“延后”，这里记录延后产生的新提醒 id。 */
  nextReminderId?: string;
  /** 如果本条是由“延后”产生，这里记录原提醒 id。 */
  snoozedFromId?: string;
};

export type DingtalkReminderStoreV1 = {
  version: 1;
  reminders: Record<string, DingtalkReminder>;
};

export type DingtalkReminderStoreV2 = {
  version: 2;
  reminders: Record<string, DingtalkReminder>;
  /** 便于用户只回复“完成/延后/取消”时定位到最近一次触发的提醒。 */
  lastSentReminderIdByUser: Record<string, string>;
};
