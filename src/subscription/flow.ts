import type { DingtalkWeatherSubscription } from "./types.js";
import { deleteDingtalkSubscription, getDingtalkSubscription, upsertDingtalkSubscription } from "./store.js";
import type { DingtalkPlace } from "../weather/types.js";
import { fetchForecast, formatForecastSummaryText, formatForecastText, geocodePlace } from "../weather/open-meteo.js";
import { parsePlaceAndDailyTime } from "./nlp.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

type DraftDetails = {
  placeQuery?: string;
  timeHHmm?: string;
};

type SessionState =
  | { kind: "awaiting_details"; draft: DraftDetails }
  | {
      kind: "awaiting_place_choice";
      placeQuery: string;
      timeHHmm: string;
      candidates: DingtalkPlace[];
    }
  | { kind: "awaiting_confirm"; draft: DingtalkWeatherSubscription };

export type SubscriptionFlowResult = { handled: false } | { handled: true; reply: string };

export type DingtalkSubscriptionFlowOptions = {
  accountId: string;
  log?: LogLike;
};

function isCancelFlowText(text: string): boolean {
  return /^(取消|算了|不订了|退出|返回)(订阅流程)?$/i.test(text.trim());
}

function isConfirmText(text: string): boolean {
  return /^(确认|确定|好的|ok|OK)$/i.test(text.trim());
}

function isStartSubscribeIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 避免误判类似“拼贴关于天气订阅的对话”这种句子。
  if (/(拼贴|整理|总结|对话|回顾|复述)/.test(t)) return false;
  if (/^(订阅天气|天气订阅)(\s|$)/.test(t)) return true;
  // 更口语的触发："我要订阅天气" / "帮我订阅一下天气"
  if (/(订阅).*(天气)/.test(t)) return true;
  // "天气订阅" 出现在短句里也算触发，避免长文本误伤。
  if (/(天气).*(订阅)/.test(t) && t.length <= 12) return true;
  return false;
}

function stripStartSubscribeIntent(text: string): string {
  return text.trim().replace(/^(订阅天气|天气订阅)\s*/g, "").trim();
}

function isListSubscriptionIntent(text: string): boolean {
  return /^(我的订阅|查看订阅)$/i.test(text.trim());
}

function isDeleteSubscriptionIntent(text: string): boolean {
  return /^(取消订阅|退订|删除订阅)$/i.test(text.trim());
}

function isExitSubscriptionIntent(text: string): boolean {
  // 有些人会说“退出订阅”，语义更像“取消订阅”（在非流程状态下）。
  return /^退出订阅$/i.test(text.trim());
}

function isExitFlowText(text: string): boolean {
  return /^(退出流程|结束流程|退出订阅流程)$/i.test(text.trim());
}

function isDetailsIntent(text: string): boolean {
  return /^(详情|天气详情|查看详情|完整指标)$/i.test(text.trim());
}

function looksLikeWeatherQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 很粗的规则：带“天气/温度”等，并且有疑问语气。
  if (!/(天气|温度|几度|下雨|雨吗|空气质量|湿度)/.test(t)) return false;
  return /[?？吗呢]$/.test(t) || /能不能|可以|帮我|告诉我|查一下|看看|请问/.test(t);
}

function shouldTreatAsPlacePhrase(placeQuery: string): boolean {
  const q = placeQuery.trim();
  if (!q) return false;
  // 规避把“能告诉我现在的天气吗”这种句子当成地点。
  if (looksLikeWeatherQuestion(q)) return false;
  if (/(拼贴|整理|总结|对话|回顾|复述)/.test(q)) return false;
  return true;
}

export function createDingtalkSubscriptionFlow(opts: DingtalkSubscriptionFlowOptions) {
  const sessions = new Map<string, SessionState>();

  async function handleAwaitingDetails(params: {
    userId: string;
    text: string;
    state: Extract<SessionState, { kind: "awaiting_details" }>;
  }): Promise<SubscriptionFlowResult> {
    const raw = params.text.trim();

    // 用户在订阅流程里问“现在天气”时，先不要硬解析成地点。
    if (looksLikeWeatherQuestion(raw)) {
      const knownPlace = params.state.draft.placeQuery;
      const knownTime = params.state.draft.timeHHmm;
      if (knownPlace && !knownTime) {
        return {
          handled: true,
          reply: `可以呀～你想订阅「${knownPlace}」的天气对吧？再告诉我每天几点推送（例如：10:20）。`,
        };
      }
      if (knownTime && !knownPlace) {
        return {
          handled: true,
          reply: `可以呀～我先记下每天 ${knownTime} 推送。你想订阅/查看哪个地方的天气？例如：成都 / 上海浦东。`,
        };
      }
      return {
        handled: true,
        reply:
          "可以呀～你想订阅哪个地方、每天几点推送？\n" +
          "你也可以直接发：成都 10:20（我会先给你一条天气预览，然后每天按时推送）。",
      };
    }

    const parsed = parsePlaceAndDailyTime(raw);
    if (parsed.kind === "multiple_times") {
      return { handled: true, reply: "目前一次订阅只支持每天一个时间点，请只写一个时间，例如：北京 8点" };
    }

    const draft: DraftDetails = { ...params.state.draft };

    if (parsed.kind === "need_place") {
      draft.timeHHmm = parsed.timeHHmm;
      if (draft.placeQuery) {
        // 用户分两条消息发了“时间”和“地点”，这里合并。
        return handleAwaitingDetails({
          userId: params.userId,
          text: `${draft.placeQuery} ${draft.timeHHmm}`,
          state: { kind: "awaiting_details", draft },
        });
      }

      sessions.set(params.userId, { kind: "awaiting_details", draft });
      return {
        handled: true,
        reply: `好～我记下每天 ${draft.timeHHmm} 推送。还差地点，发个城市/区县就行，例如：成都 / 上海浦东。`,
      };
    }

    if (parsed.kind === "need_time") {
      if (shouldTreatAsPlacePhrase(parsed.placeQuery)) {
        draft.placeQuery = parsed.placeQuery;
      }

      if (draft.timeHHmm && draft.placeQuery) {
        // 用户分两条消息发了“地点”和“时间”，这里合并。
        return handleAwaitingDetails({
          userId: params.userId,
          text: `${draft.placeQuery} ${draft.timeHHmm}`,
          state: { kind: "awaiting_details", draft },
        });
      }

      sessions.set(params.userId, { kind: "awaiting_details", draft });
      if (!draft.placeQuery) {
        return {
          handled: true,
          reply:
            "我明白你在聊天气～但我还不知道你要订阅哪个地方。\n" +
            "订阅的话直接发：成都 10:20（地点 + 时间）。",
        };
      }
      return {
        handled: true,
        reply: `好～地点记为「${draft.placeQuery}」。还差每天几点推送，例如：08:00 或 8点半。`,
      };
    }

    if (parsed.kind === "need_both") {
      // 结合已记住的草稿，尽量把提示说人话。
      sessions.set(params.userId, { kind: "awaiting_details", draft });
      if (draft.placeQuery && !draft.timeHHmm) {
        return { handled: true, reply: `你想订阅「${draft.placeQuery}」对吧？再告诉我每天几点推送，例如：10:20。` };
      }
      if (draft.timeHHmm && !draft.placeQuery) {
        return { handled: true, reply: `我记下每天 ${draft.timeHHmm} 推送。再告诉我地点，例如：成都 / 上海浦东。` };
      }
      return {
        handled: true,
        reply: "想订阅的话直接发：目标地区 + 推送时间，例如：成都 10:20（也支持“每天8点”这种写法）",
      };
    }

    // parsed.kind === "ok"
    const { placeQuery, timeHHmm } = parsed;
    let candidates: DingtalkPlace[] = [];
    try {
      candidates = await geocodePlace({ query: placeQuery, count: 3 });
    } catch (err: any) {
      opts.log?.warn?.(`[dingtalk] geocode failed: ${String(err?.message ?? err)}`);
      return { handled: true, reply: "地点解析失败：当前环境可能无法访问地理服务（需要可出网）。请稍后重试。" };
    }
    if (candidates.length === 0) {
      return { handled: true, reply: `没找到地点：${placeQuery}\n请换个写法再试一次（例如：北京 朝阳 / 深圳 南山）。` };
    }

    if (candidates.length === 1) {
      const place = candidates[0];
      const existing = await getDingtalkSubscription({ userId: params.userId, accountId: opts.accountId });
      const now = Date.now();
      const draft: DingtalkWeatherSubscription = {
        userId: params.userId,
        place,
        schedule: { type: "daily", time: timeHHmm },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastSentLocalDate: existing?.lastSentLocalDate,
      };
      sessions.set(params.userId, { kind: "awaiting_confirm", draft });
      return {
        handled: true,
        reply:
          `我理解的是：订阅 ${place.label}（${place.timezone}），每天 ${timeHHmm} 推送。\n` +
          `回复“确认”保存，回复“取消”退出。`,
      };
    }

    sessions.set(params.userId, { kind: "awaiting_place_choice", placeQuery, timeHHmm, candidates });
    const lines = candidates.map((c, i) => `${i + 1}) ${c.label}（${c.timezone}）`).join("\n");
    return {
      handled: true,
      reply:
        `我找到了多个“${placeQuery}”，你想订阅哪一个？回复编号即可（我会每天 ${timeHHmm} 推送）：\n` +
        `${lines}\n` +
        `回复“取消”退出。`,
    };
  }

  async function handleMessage(params: { userId: string; text: string }): Promise<SubscriptionFlowResult> {
    const raw = params.text.trim();
    if (!raw) return { handled: false };

    const state = sessions.get(params.userId);

    // 明确的“退出流程”语句：不要交给大模型，避免产生奇怪的“结束会话”回应。
    if (isExitFlowText(raw)) {
      if (state) {
        sessions.delete(params.userId);
        return { handled: true, reply: "好的～已退出订阅设置。需要的话随时发“订阅天气”。" };
      }
      return {
        handled: true,
        reply: "当前没有在订阅设置流程里。\n想订阅：发送“订阅天气”。\n想取消订阅：发送“取消订阅”。",
      };
    }

    // 流程中优先允许用户“随时退出”
    if (state && (isCancelFlowText(raw) || /^退出订阅$/i.test(raw))) {
      sessions.delete(params.userId);
      return { handled: true, reply: "好的～已退出订阅设置。需要的话随时发“订阅天气”。" };
    }

    // “详情”：展示完整指标（如果用户有订阅，或正在确认订阅）
    if (isDetailsIntent(raw)) {
      const place =
        state && state.kind === "awaiting_confirm"
          ? state.draft.place
          : (await getDingtalkSubscription({ userId: params.userId, accountId: opts.accountId }))?.place;

      if (!place) return { handled: false };

      try {
        const forecast = await fetchForecast({ place });
        return { handled: true, reply: formatForecastText({ place, forecast, title: "天气详情" }) };
      } catch (err: any) {
        opts.log?.warn?.(`[dingtalk] details fetch failed: ${String(err?.message ?? err)}`);
        return { handled: true, reply: "获取天气详情失败：可能当前无法访问天气服务（需要可出网）。请稍后重试。" };
      }
    }

    // 全局命令（不要求在订阅流程里）
    if (isListSubscriptionIntent(raw)) {
      const sub = await getDingtalkSubscription({ userId: params.userId, accountId: opts.accountId });
      if (!sub) return { handled: true, reply: "你还没有订阅天气。\n发送“订阅天气”开始订阅。" };
      return {
        handled: true,
        reply: `当前订阅：${sub.place.label}（${sub.place.timezone}） 每天 ${sub.schedule.time} 推送。\n发送“取消订阅”可删除。`,
      };
    }

    if (isDeleteSubscriptionIntent(raw)) {
      const existed = await deleteDingtalkSubscription({ userId: params.userId, accountId: opts.accountId });
      sessions.delete(params.userId);
      return { handled: true, reply: existed ? "已取消订阅。" : "你还没有订阅，无需取消。" };
    }

    if (!state && isExitSubscriptionIntent(raw)) {
      const existed = await deleteDingtalkSubscription({ userId: params.userId, accountId: opts.accountId });
      return { handled: true, reply: existed ? "已取消订阅。" : "你还没有订阅，无需取消。" };
    }

    // 会话内流程（订阅设置）
    if (state) {
      if (state.kind === "awaiting_details") {
        return handleAwaitingDetails({ ...params, state });
      }

      if (state.kind === "awaiting_place_choice") {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > state.candidates.length) {
          return { handled: true, reply: `输入不符合规则，请回复 1-${state.candidates.length} 之间的编号，或回复“取消”。` };
        }
        const place = state.candidates[n - 1];
        const existing = await getDingtalkSubscription({ userId: params.userId, accountId: opts.accountId });
        const now = Date.now();
        const draft: DingtalkWeatherSubscription = {
          userId: params.userId,
          place,
          schedule: { type: "daily", time: state.timeHHmm },
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastSentLocalDate: existing?.lastSentLocalDate,
        };
        sessions.set(params.userId, { kind: "awaiting_confirm", draft });
        return {
          handled: true,
          reply:
            `我理解的是：订阅 ${place.label}（${place.timezone}），每天 ${state.timeHHmm} 推送。\n` +
            `回复“确认”保存，回复“取消”退出。`,
        };
      }

      if (state.kind === "awaiting_confirm") {
        if (!isConfirmText(raw)) {
          return { handled: true, reply: "再确认一下：回复“确认”保存订阅，或回复“取消”退出。" };
        }
        try {
          await upsertDingtalkSubscription({ subscription: state.draft, accountId: opts.accountId });
        } catch (err: any) {
          opts.log?.warn?.(`[dingtalk] failed to persist subscription: ${String(err?.message ?? err)}`);
          return { handled: true, reply: "保存订阅失败：请稍后重试。" };
        }
        sessions.delete(params.userId);
        // 订阅成功后给一条“天气预览”，让用户更有“会用”的感觉（失败也不影响订阅本身）。
        try {
          const forecast = await fetchForecast({ place: state.draft.place });
          const preview = formatForecastSummaryText({ place: state.draft.place, forecast, title: "天气预览" });
          return {
            handled: true,
            reply:
              "订阅成功！\n\n" +
              preview +
              "\n\n发送“我的订阅”查看，发送“取消订阅”删除。",
          };
        } catch (err: any) {
          opts.log?.warn?.(`[dingtalk] preview fetch failed: ${String(err?.message ?? err)}`);
          return { handled: true, reply: "订阅成功！你可以发送“我的订阅”查看，或发送“取消订阅”删除。" };
        }
      }
    }

    // 进入订阅流程
    if (isStartSubscribeIntent(raw)) {
      const rest = stripStartSubscribeIntent(raw);
      if (!rest) {
        sessions.set(params.userId, { kind: "awaiting_details", draft: {} });
        return {
          handled: true,
          reply:
            "好呀～你想订阅哪个地方、每天几点推送？\n" +
            "直接发：成都 10:20（地点 + 时间）。\n" +
            "回复“取消”可随时退出。",
        };
      }

      // 用户在同一条消息里直接提供了详情。
      const state: Extract<SessionState, { kind: "awaiting_details" }> = { kind: "awaiting_details", draft: {} };
      sessions.set(params.userId, state);
      return handleAwaitingDetails({ userId: params.userId, text: rest, state });
    }

    return { handled: false };
  }

  return {
    handleMessage,
  };
}
