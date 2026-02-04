---
name: dingtalk-reminder
description: 钉钉提醒/闹钟（一次性提醒）。
metadata: {"openclaw":{"emoji":"⏰"}}
---

# 钉钉提醒（DingTalk Reminder）

你可以帮助用户设置一次性提醒（闹钟），并在到点时由机器人主动发消息提醒用户。

## 何时使用

- 用户说“提醒我… / 叫我一下 / 闹钟 / 下班提醒 / 几点叫我…”

如果用户在问天气，请切换到天气相关工具，不要误触发提醒。

## 可用工具

- `dingtalk_reminder_create(text, userId?, timeZone?)`：创建提醒（推荐直接传用户原句）
- `dingtalk_reminder_list(userId?)`：查看提醒
- `dingtalk_reminder_cancel(id, userId?)`：取消提醒

## 对话规则（务必遵守）

1) 优先确保时间明确：
   - 如果用户没说清“几点几分”，先追问时间（例如：16:40 / 4点半 / 下午六点）。

2) 默认时区：
   - 若用户没明确时区，默认按 `Asia/Shanghai` 解释时间。

3) 输出要自然简洁：
   - 创建成功后告诉用户触发时间与提醒内容，并提示“我的提醒 / 取消提醒 <id>”。

