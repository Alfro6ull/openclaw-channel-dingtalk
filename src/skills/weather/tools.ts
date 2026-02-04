import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";

import { fetchForecast, formatForecastSummaryText, formatForecastText, geocodePlace } from "./open-meteo.js";
import { parsePlaceAndDailyTime } from "./subscription/nlp.js";
import { deleteDingtalkSubscription, getDingtalkSubscription, upsertDingtalkSubscription } from "./subscription/store.js";
import type { DingtalkPlace, DingtalkWeatherSubscription } from "./subscription/types.js";
import {
  clearWeatherPendingSelection,
  peekWeatherPendingSelection,
  resolveDingtalkUserId,
  setWeatherPendingSelection,
  type WeatherPendingAction,
} from "./session-state.js";

type LogLike = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

function normalizeAccountId(accountId: unknown): string | undefined {
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function pickUserId(toolCtx: OpenClawPluginToolContext, params: Record<string, unknown>): string | null {
  const explicit = typeof params.userId === "string" ? params.userId.trim() : "";
  if (explicit) return explicit;
  return resolveDingtalkUserId({ sessionKey: toolCtx.sessionKey });
}

function formatPlaceChoices(places: DingtalkPlace[]): string {
  const lines: string[] = [];
  for (const [idx, place] of places.entries()) {
    lines.push(`${idx + 1}) ${place.label}${place.timezone ? `（${place.timezone}）` : ""}`);
  }
  return lines.join("\n").slice(0, 1200);
}

function toolText(text: string, details: unknown = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

async function fetchSummary(place: DingtalkPlace, title?: string) {
  const forecast = await fetchForecast({ place });
  return formatForecastSummaryText({ place, forecast, title: title ?? "天气预览" });
}

async function fetchDetails(place: DingtalkPlace, title?: string) {
  const forecast = await fetchForecast({ place });
  return formatForecastText({ place, forecast, title: title ?? "天气详情" });
}

async function ensureSinglePlace(params: {
  toolCtx: OpenClawPluginToolContext;
  query: string;
  action: WeatherPendingAction;
}): Promise<
  | { kind: "ok"; place: DingtalkPlace }
  | { kind: "none" }
  | { kind: "choose"; places: DingtalkPlace[] }
> {
  const places = await geocodePlace({ query: params.query, count: 3 });
  if (places.length === 0) return { kind: "none" };
  if (places.length === 1) return { kind: "ok", place: places[0] };
  setWeatherPendingSelection({ sessionKey: params.toolCtx.sessionKey, places, action: params.action });
  return { kind: "choose", places };
}

async function upsertSubscription(params: {
  accountId?: string;
  userId: string;
  place: DingtalkPlace;
  timeHHmm: string;
}) {
  const now = Date.now();
  const sub: DingtalkWeatherSubscription = {
    userId: params.userId,
    place: params.place,
    schedule: { type: "daily", time: params.timeHHmm },
    createdAt: now,
    updatedAt: now,
  };
  await upsertDingtalkSubscription({ subscription: sub, accountId: params.accountId });
  return sub;
}

export function createDingtalkWeatherToolsFactory(params: { log?: LogLike }) {
  return (toolCtx: OpenClawPluginToolContext): AnyAgentTool[] => {
    const accountId = normalizeAccountId(toolCtx.agentAccountId);

    const tools: AnyAgentTool[] = [];

    tools.push({
      name: "dingtalk_weather_now",
      label: "天气（概况）",
      description:
        "查询天气概况（中文摘要）。如果不提供 place，则默认使用该用户的天气订阅地点。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          place: { type: "string", description: "地点（例如：成都 / 北京朝阳 / 上海浦东）。可选。" },
          userId: {
            type: "string",
            description: "钉钉用户ID（可选；不填则从会话上下文推断）。",
          },
        },
      },
      execute: async (_toolCallId, input) => {
        const paramsObj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, paramsObj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const placeQuery = typeof paramsObj.place === "string" ? paramsObj.place.trim() : "";
        let place: DingtalkPlace | null = null;

        if (placeQuery) {
          const resolved = await ensureSinglePlace({ toolCtx, query: placeQuery, action: { kind: "now" } });
          if (resolved.kind === "none") {
            return toolText(`没找到地点：${placeQuery}\n你可以换个写法再试一次（例如：北京朝阳 / 深圳南山）。`, {
              ok: false,
              reason: "place_not_found",
            });
          }
          if (resolved.kind === "choose") {
            return toolText(`我找到了多个“${placeQuery}”，你指的是哪一个？回复编号即可：\n${formatPlaceChoices(resolved.places)}`, {
              ok: false,
              reason: "place_ambiguous",
              choices: resolved.places,
              nextTool: "dingtalk_weather_pick_place",
            });
          }
          place = resolved.place;
        } else {
          const sub = await getDingtalkSubscription({ userId, accountId });
          if (!sub) {
            return toolText("你还没有设置天气订阅。你可以直接问我“成都现在天气怎么样”，或者说“我想订阅成都每天10:20推送”。", {
              ok: false,
              reason: "no_subscription",
            });
          }
          place = sub.place;
        }

        const text = await fetchSummary(place, "天气预览");
        return toolText(text, { ok: true, place });
      },
    });

    tools.push({
      name: "dingtalk_weather_details",
      label: "天气（详情）",
      description:
        "查询天气完整指标（较长）。如果不提供 place，则默认使用该用户的天气订阅地点。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          place: { type: "string", description: "地点（可选）。" },
          userId: {
            type: "string",
            description: "钉钉用户ID（可选；不填则从会话上下文推断）。",
          },
        },
      },
      execute: async (_toolCallId, input) => {
        const paramsObj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, paramsObj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const placeQuery = typeof paramsObj.place === "string" ? paramsObj.place.trim() : "";
        let place: DingtalkPlace | null = null;

        if (placeQuery) {
          const resolved = await ensureSinglePlace({ toolCtx, query: placeQuery, action: { kind: "details" } });
          if (resolved.kind === "none") {
            return toolText(`没找到地点：${placeQuery}\n你可以换个写法再试一次（例如：北京朝阳 / 深圳南山）。`, {
              ok: false,
              reason: "place_not_found",
            });
          }
          if (resolved.kind === "choose") {
            return toolText(`我找到了多个“${placeQuery}”，你指的是哪一个？回复编号即可：\n${formatPlaceChoices(resolved.places)}`, {
              ok: false,
              reason: "place_ambiguous",
              choices: resolved.places,
              nextTool: "dingtalk_weather_pick_place",
            });
          }
          place = resolved.place;
        } else {
          const sub = await getDingtalkSubscription({ userId, accountId });
          if (!sub) {
            return toolText("你还没有设置天气订阅。请告诉我你想看的地点，例如：成都。", {
              ok: false,
              reason: "no_subscription",
            });
          }
          place = sub.place;
        }

        const text = await fetchDetails(place, "天气详情");
        return toolText(text, { ok: true, place });
      },
    });

    tools.push({
      name: "dingtalk_weather_subscribe",
      label: "订阅天气",
      description:
        "创建/更新天气订阅：单一地点 + 每天一个时间点（按地点时区理解）。需要提供 place 与 time。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["place", "time"],
        properties: {
          place: { type: "string", description: "地点（例如：成都 / 上海浦东 / 北京朝阳）。" },
          time: { type: "string", description: "每天推送时间（例如：10:20 / 8点半 / 早上八点）。" },
          userId: {
            type: "string",
            description: "钉钉用户ID（可选；不填则从会话上下文推断）。",
          },
        },
      },
      execute: async (_toolCallId, input) => {
        const paramsObj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, paramsObj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const placeRaw = typeof paramsObj.place === "string" ? paramsObj.place.trim() : "";
        const timeRaw = typeof paramsObj.time === "string" ? paramsObj.time.trim() : "";
        const parsed = parsePlaceAndDailyTime(`${placeRaw} ${timeRaw}`);
        if (parsed.kind !== "ok") {
          return toolText("我没能从输入里解析出“地点 + 时间”。你可以这样说：成都 10:20 / 北京朝阳 每天8点半", {
            ok: false,
            reason: "parse_failed",
            parsed,
          });
        }

        const resolved = await ensureSinglePlace({
          toolCtx,
          query: parsed.placeQuery,
          action: { kind: "subscribe", timeHHmm: parsed.timeHHmm },
        });

        if (resolved.kind === "none") {
          return toolText(`没找到地点：${parsed.placeQuery}\n你可以换个写法再试一次（例如：北京朝阳 / 深圳南山）。`, {
            ok: false,
            reason: "place_not_found",
          });
        }

        if (resolved.kind === "choose") {
          return toolText(
            `我找到了多个“${parsed.placeQuery}”，你想订阅哪一个？回复编号即可（我会每天 ${parsed.timeHHmm} 推送）：\n${formatPlaceChoices(resolved.places)}`,
            {
              ok: false,
              reason: "place_ambiguous",
              timeHHmm: parsed.timeHHmm,
              choices: resolved.places,
              nextTool: "dingtalk_weather_pick_place",
            },
          );
        }

        const sub = await upsertSubscription({
          accountId,
          userId,
          place: resolved.place,
          timeHHmm: parsed.timeHHmm,
        });

        const preview = await fetchSummary(resolved.place, "天气预览");

        const text = [
          `订阅成功！我会每天 ${sub.schedule.time}（${sub.place.timezone}）推送「${sub.place.label}」的天气。`,
          "",
          "我先给你一条天气预览：",
          preview,
        ]
          .join("\n")
          .slice(0, 3500);

        return toolText(text, { ok: true, subscription: sub });
      },
    });

    tools.push({
      name: "dingtalk_weather_list",
      label: "我的订阅",
      description: "查看该用户的天气订阅（单条）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const paramsObj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, paramsObj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const sub = await getDingtalkSubscription({ userId, accountId });
        if (!sub) return toolText("你目前没有天气订阅。你可以说：订阅 成都 每天10:20", { ok: true, subscription: null });
        return toolText(
          `当前订阅：${sub.place.label}（${sub.place.timezone}）每天 ${sub.schedule.time} 推送。`,
          { ok: true, subscription: sub },
        );
      },
    });

    tools.push({
      name: "dingtalk_weather_unsubscribe",
      label: "取消订阅",
      description: "删除该用户的天气订阅。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const paramsObj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, paramsObj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const existed = await deleteDingtalkSubscription({ userId, accountId });
        return toolText(existed ? "已取消订阅。想重新订阅的话，直接说：订阅 成都 每天10:20" : "你目前没有订阅需要取消。", {
          ok: true,
          existed,
        });
      },
    });

    tools.push({
      name: "dingtalk_weather_pick_place",
      label: "选择地点",
      description:
        "当地点出现多个候选项时，用序号选择并继续执行上一件事（查天气/查详情/订阅）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["index"],
        properties: {
          index: { type: "integer", minimum: 1, maximum: 10, description: "候选项序号（从 1 开始）。" },
          userId: { type: "string", description: "钉钉用户ID（可选；不填则从会话上下文推断）。" },
        },
      },
      execute: async (_toolCallId, input) => {
        const paramsObj = (input ?? {}) as Record<string, unknown>;
        const userId = pickUserId(toolCtx, paramsObj);
        if (!userId) return toolText("我现在还无法识别你的钉钉用户ID（请先在钉钉私聊我发一句话，再重试）。", { ok: false });

        const pending = peekWeatherPendingSelection({ sessionKey: toolCtx.sessionKey });
        if (!pending) return toolText("我这边没有待选择的地点。你可以重新说一次：成都 10:20 / 现在成都天气", { ok: false });

        const indexRaw = paramsObj.index;
        const index = typeof indexRaw === "number" ? indexRaw : Number(String(indexRaw ?? "").trim());
        if (!Number.isFinite(index) || index < 1 || index > pending.places.length) {
          return toolText(`序号不对。请回复 1～${pending.places.length} 之间的数字。`, {
            ok: false,
            reason: "bad_index",
          });
        }

        const place = pending.places[index - 1];
        clearWeatherPendingSelection({ sessionKey: toolCtx.sessionKey });

        if (pending.action.kind === "now") {
          const text = await fetchSummary(place, "天气预览");
          return toolText(text, { ok: true, place });
        }

        if (pending.action.kind === "details") {
          const text = await fetchDetails(place, "天气详情");
          return toolText(text, { ok: true, place });
        }

        const sub = await upsertSubscription({
          accountId,
          userId,
          place,
          timeHHmm: pending.action.timeHHmm,
        });

        const preview = await fetchSummary(place, "天气预览");
        const text = [
          `订阅成功！我会每天 ${sub.schedule.time}（${sub.place.timezone}）推送「${sub.place.label}」的天气。`,
          "",
          "我先给你一条天气预览：",
          preview,
        ]
          .join("\n")
          .slice(0, 3500);

        return toolText(text, { ok: true, subscription: sub });
      },
    });

    params.log?.info?.(`[dingtalk] weather tools registered (sessionKey=${toolCtx.sessionKey ?? "(none)"})`);
    return tools;
  };
}
