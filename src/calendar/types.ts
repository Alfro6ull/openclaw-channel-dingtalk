// 钉钉日历/会议提醒相关类型定义。

export type DingtalkCalendarWatch = {
  userId: string;
  enabled: boolean;
  /** 会前多少分钟提醒。 */
  minutesBefore: number;
  /** 展示/解释时间用的时区（默认 Asia/Shanghai）。 */
  timeZone: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type DingtalkCalendarStoreV1 = {
  version: 1;
  watches: Record<string, DingtalkCalendarWatch>;
  /** 缓存用户的主日历 id，避免每次都拉取列表。 */
  primaryCalendarIdByUser: Record<string, string>;
  /** 去重：同一场会议不要重复提醒（key 通常为 eventId|startDateTime）。 */
  notifiedKeysByUser: Record<string, string[]>;
};

