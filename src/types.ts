export type DingtalkConnectionMode = "stream" | "webhook";

export type DingtalkConfig = {
  enabled?: boolean;
  // 钉钉企业内部应用凭证。
  // 钉钉文档里通常叫 "Client ID" / "Client Secret"。
  clientId?: string;
  clientSecret?: string;

  // 兼容别名（appKey/appSecret）。
  appKey?: string;
  appSecret?: string;

  // 用于 OpenAPI 的“机器人发消息”相关接口。
  robotCode?: string;

  debug?: boolean;

  subscription?: {
    /** 调度器 tick 间隔（秒），默认 60 */
    tickSeconds?: number;
  };

  // TODO：如果后续实现 webhook 模式（签名/加解密），配置放这里。
  connectionMode?: DingtalkConnectionMode;
  webhookPath?: string;
  webhookPort?: number;
};

export type ResolvedDingtalkAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  config: DingtalkConfig;
};
