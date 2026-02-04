import type { DingtalkPlace, DingtalkWeatherSubscription } from "./subscription-types.js";
import { deleteDingtalkSubscription, getDingtalkSubscription, upsertDingtalkSubscription } from "./subscription-store.js";
import { geocodePlace } from "./open-meteo.js";
import { parsePlaceAndDailyTime } from "./subscription-nlp.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

type SessionState =
  | { kind: "awaiting_details" }
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

function isCancelText(text: string): boolean {
  return /^(取消|算了|不订了|退出|返回)$/i.test(text.trim());
}

function isConfirmText(text: string): boolean {
  return /^(确认|确定|好的|ok|OK)$/i.test(text.trim());
}

function isStartSubscribeIntent(text: string): boolean {
  return /(订阅天气|天气订阅)/.test(text);
}

function stripStartSubscribeIntent(text: string): string {
  return text.replace(/订阅天气|天气订阅/g, "").trim();
}

export function createDingtalkSubscriptionFlow(opts: DingtalkSubscriptionFlowOptions) {
  const sessions = new Map<string, SessionState>();

  async function handleAwaitingDetails(params: {
    userId: string;
    text: string;
  }): Promise<SubscriptionFlowResult> {
    const parsed = parsePlaceAndDailyTime(params.text);
    if (parsed.kind === "multiple_times") {
      return { handled: true, reply: "目前一次订阅只支持每天一个时间点，请只写一个时间，例如：北京 8点" };
    }
    if (parsed.kind === "need_both") {
      return { handled: true, reply: "请发送：目标地区 + 推送时间，例如：北京 每天8点" };
    }
    if (parsed.kind === "need_place") {
      return { handled: true, reply: `已识别时间为每天 ${parsed.timeHHmm}，还缺地点。请只发送地点，例如：北京 / 上海浦东` };
    }
    if (parsed.kind === "need_time") {
      return { handled: true, reply: `已识别地点为“${parsed.placeQuery}”，还缺推送时间。请发送每天几点，例如：08:00 或 8点半` };
    }

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
          `确认订阅：${place.label}（${place.timezone}） 每天 ${timeHHmm} 推送。\n` +
          `回复“确认”保存，回复“取消”退出。`,
      };
    }

    sessions.set(params.userId, { kind: "awaiting_place_choice", placeQuery, timeHHmm, candidates });
    const lines = candidates.map((c, i) => `${i + 1}) ${c.label}（${c.timezone}）`).join("\n");
    return {
      handled: true,
      reply:
        `我找到了多个“${placeQuery}”，请回复编号选择：\n` +
        `${lines}\n` +
        `回复“取消”退出。`,
    };
  }

  async function handleMessage(params: { userId: string; text: string }): Promise<SubscriptionFlowResult> {
    const raw = params.text.trim();
    if (!raw) return { handled: false };

    // 全局命令
    if (/^(我的订阅|查看订阅)$/i.test(raw)) {
      const sub = await getDingtalkSubscription({ userId: params.userId, accountId: opts.accountId });
      if (!sub) return { handled: true, reply: "你还没有订阅天气。\n发送“订阅天气”开始订阅。" };
      return {
        handled: true,
        reply: `当前订阅：${sub.place.label}（${sub.place.timezone}） 每天 ${sub.schedule.time} 推送。\n发送“取消订阅”可删除。`,
      };
    }

    if (/^(取消订阅|退订)$/i.test(raw)) {
      const existed = await deleteDingtalkSubscription({ userId: params.userId, accountId: opts.accountId });
      sessions.delete(params.userId);
      return { handled: true, reply: existed ? "已取消订阅。" : "你还没有订阅，无需取消。" };
    }

    // 会话内流程
    const state = sessions.get(params.userId);
    if (state) {
      if (isCancelText(raw)) {
        sessions.delete(params.userId);
        return { handled: true, reply: "已取消当前操作。" };
      }

      if (state.kind === "awaiting_details") {
        return handleAwaitingDetails(params);
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
            `确认订阅：${place.label}（${place.timezone}） 每天 ${state.timeHHmm} 推送。\n` +
            `回复“确认”保存，回复“取消”退出。`,
        };
      }

      if (state.kind === "awaiting_confirm") {
        if (!isConfirmText(raw)) {
          return { handled: true, reply: "请回复“确认”保存订阅，或回复“取消”退出。" };
        }
        try {
          await upsertDingtalkSubscription({ subscription: state.draft, accountId: opts.accountId });
        } catch (err: any) {
          opts.log?.warn?.(`[dingtalk] failed to persist subscription: ${String(err?.message ?? err)}`);
          return { handled: true, reply: "保存订阅失败：请稍后重试。" };
        }
        sessions.delete(params.userId);
        return { handled: true, reply: "订阅成功！你可以发送“我的订阅”查看，或发送“取消订阅”删除。" };
      }
    }

    // 进入订阅流程
    if (isStartSubscribeIntent(raw)) {
      const rest = stripStartSubscribeIntent(raw);
      if (!rest) {
        sessions.set(params.userId, { kind: "awaiting_details" });
        return {
          handled: true,
          reply: "订阅天气：请发送目标地区及推送时间，例如：北京 每天8点 / 上海浦东 18:30\n回复“取消”可退出。",
        };
      }

      // 用户在同一条消息里直接提供了详情。
      sessions.set(params.userId, { kind: "awaiting_details" });
      return handleAwaitingDetails({ userId: params.userId, text: rest });
    }

    return { handled: false };
  }

  return {
    handleMessage,
  };
}
