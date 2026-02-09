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

- `dingtalk_reminder_create(time, message?, dayOffset?, date?, userId?, timeZone?)`：创建提醒（你需要先从用户话里提取结构化时间）
- `dingtalk_reminder_list(userId?)`：查看提醒
- `dingtalk_reminder_cancel(id, userId?)`：取消提醒

## 对话规则（务必遵守）

1) 优先确保时间明确：
   - 如果用户没说清“几点几分”，先追问时间（例如：18:00 / 09:30）。
   - 如果用户说“6点”但无法判断早晚，先追问是“06:00 还是 18:00”。

2) 默认时区：
   - 若用户没明确时区，默认按 `Asia/Shanghai` 解释时间。

3) 输出要自然简洁：
   - 创建成功后告诉用户触发时间与提醒内容，并提示“我的提醒 / 取消提醒 <id>”。

4) 调用工具时务必做归一化：
   - `time` 一律使用 24 小时制 `HH:mm`（例如把“下午六点”归一化为 `18:00`）
   - 如果用户说“明天/后天”，用 `dayOffset` 表示（1/2）。
   - 如果用户给了明确日期（例如 2026-02-10），用 `date`（YYYY-MM-DD）而不是 dayOffset。
