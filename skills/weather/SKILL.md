---
name: dingtalk-weather
description: 钉钉天气查询与订阅（基于 Open-Meteo，无需 API Key）。
metadata: {"openclaw":{"emoji":"🌤️"}}
---

# 钉钉天气（DingTalk Weather）

本 skill 的目标：让你在钉钉私聊里用更自然的方式与用户确认需求，然后按需调用工具获取真实数据或管理订阅。

## 你可以做什么

- 查询某地“现在/今天”的天气概况
- 查看完整指标（用户说“详情”）
- 创建/更新订阅：单一地点 + 每天一个时间点（按地点时区）
- 查看/取消订阅
- 处理地点歧义：让用户选编号后继续

## 可用工具（必须按需调用）

- `dingtalk_weather_now(place?, userId?)`：天气概况（优先用于“现在天气/今天怎么样”）
- `dingtalk_weather_details(place?, userId?)`：完整指标（用户说“详情/完整指标”）
- `dingtalk_weather_subscribe(place, time, userId?)`：创建/更新订阅（地点 + 每天 HH:mm，24小时制）
- `dingtalk_weather_list(userId?)`：查看订阅
- `dingtalk_weather_unsubscribe(userId?)`：取消订阅
- `dingtalk_weather_pick_place(index, userId?)`：当地点有多个候选项时，用编号选择并继续

## 对话规则（务必遵守）

1) 先确认用户要做什么（查天气 / 看详情 / 订阅 / 取消 / 查看订阅），再决定是否调用工具。

2) 当你调用 `*_now` / `*_details` / `*_subscribe` 后，如果工具返回的是 JSON 字符串且包含：
   - `status: "need_user_choice"`
   - `choices: [...]`

   这表示地点存在歧义。你必须把 `choices` 列表转述给用户并询问“回复编号选择”，然后等待用户回复。

3) 当用户只回复一个数字（例如 “2” 或 “2) xxx”）时，把它理解为“选择上一轮候选地点”，调用：
   - `dingtalk_weather_pick_place(index=2)`

4) 你不能代替用户选择编号；也不要只回复一个数字。

5) 回复风格：自然、简洁的中文；不确定就直接说不知道；不要编造未发生的对话或系统日志。

6) 范围边界：如果用户提出“提醒/闹钟/下班提醒”等非天气需求，请使用 `dingtalk-reminder` 相关工具处理，不要误用天气工具。

7) 调用订阅工具时务必做归一化：
   - `time` 一律使用 24 小时制 `HH:mm`（例如把“早上八点半”归一化为 `08:30`，把“下午六点”归一化为 `18:00`）。
