# openclaw-channel-dingtalk

  可用功能：
    - webchat
    - 天气订阅 孩子有点呆傻不建议使用

## 安装

- 方式 A：
  - `openclaw plugins install https://github.com/alfro6ull-collab/openclaw-channel-dingtalk.git`

- 方式 B：先 clone，再 link 本地目录
  - `git clone git@github.com:alfro6ull-collab/openclaw-channel-dingtalk.git`
  - `cd openclaw-channel-dingtalk`
  - `openclaw plugins install -l .`

装完可用 `openclaw plugins list` 看看是否出现 `dingtalk`。

## 钉钉开放平台

### 创建应用

### 添加机器人并配置

**stream模式**

### 权限配置和事件订阅
按需配置

```yaml
plugins:
  entries:
    dingtalk:
      enabled: true

channels:
  dingtalk:
    enabled: true
    clientId: "dingxxxxxxxxxxxxxxxx"
    clientSecret: "xxxxxxxxxxxxxxxx"
    robotCode: "dingxxxxxxxxxxxxxxxx"
    # 订阅调度 tick 间隔（秒），默认 60
    subscription:
      tickSeconds: 60
```

### CLI 写入 `~/.openclaw/openclaw.json`）

- `openclaw config set plugins.entries.dingtalk.enabled true`
- `openclaw config set channels.dingtalk.enabled true`
- `openclaw config set channels.dingtalk.clientId "dingxxxxxxxxxxxxxxxx"`
- `openclaw config set channels.dingtalk.clientSecret "xxxxxxxxxxxxxxxx"`
- （可选）`openclaw config set channels.dingtalk.robotCode "dingxxxxxxxxxxxxxxxx"`
  改完配置后需要重启 gateway（不管是 docker 还是本机跑）才能生效。

## 使用

### 天气订阅
目前是单一地点单一时间

1. 私聊发送：`订阅天气`
2. 按提示发送：`目标地区 + 推送时间`
  示例（支持自然语言）：
  - `北京 每天8点`
  - `上海浦东 18:30`
  - `深圳南山 早上八点半`

> 说明：时间会按“地点所在时区”理解与触发（由 Open‑Meteo 地理编码返回）。

### 查看/取消订阅

- 查看：发送 `我的订阅` 或 `查看订阅`
- 取消：发送 `取消订阅` 或 `退订`
- 退出订阅流程：发送 `取消`

## 权限（补充说明）

本插件需要两类能力：

1) **Stream 接入**（接收消息/事件推送）  
2) **OpenAPI 主动发消息**（用于“订阅定时推送”，不能依赖 sessionWebhook）

- 获取企业内部应用 `accessToken`（用于 OpenAPI 调用）
- 企业内机器人发送消息权限（用于主动推送到“人与机器人会话”）

## 可能的问题

### 1) 订阅创建失败 / 推送失败（地点解析失败）

天气是调用的 Open‑Meteo（地理编码 + 天气接口），需要出网。

## 参考文档

- 钉钉：事件订阅（Stream 模式）文档与协议说明：`https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol`
- 钉钉：机器人回复与发送消息（概念说明）：`https://open.dingtalk.com/document/dingstart/robot-reply-and-send-messages`
- 钉钉：获取企业内部应用 accessToken：`https://open.dingtalk.com/document/orgapp/obtain-the-access_token-of-an-internal-app`
- 钉钉：机器人批量发送人与机器人会话消息：`https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches`
- 钉钉：添加/管理 API 权限：`https://open.dingtalk.com/document/orgapp-server/add-api-permission`
- Open‑Meteo：Geocoding API（地点解析）：`https://open-meteo.com/en/docs/geocoding-api`
- Open‑Meteo：Weather Forecast API（天气接口）：`https://open-meteo.com/en/docs`
