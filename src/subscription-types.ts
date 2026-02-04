export type DingtalkPlace = {
  query: string;
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

export type DingtalkDailySchedule = {
  type: "daily";
  /** 地点所在时区的本地时间，格式为 HH:mm（24 小时制）。 */
  time: string;
};

export type DingtalkWeatherSubscription = {
  userId: string;
  place: DingtalkPlace;
  schedule: DingtalkDailySchedule;
  createdAt: number;
  updatedAt: number;
  /** 上次成功推送时的“本地日期”（YYYY-MM-DD，按地点时区计算）。 */
  lastSentLocalDate?: string;
};

export type DingtalkSubscriptionStoreV1 = {
  version: 1;
  subscriptions: Record<string, DingtalkWeatherSubscription>;
};
