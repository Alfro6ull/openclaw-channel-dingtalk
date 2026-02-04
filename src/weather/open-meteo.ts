import axios from "axios";

import type { DingtalkPlace } from "./subscription/types.js";

// 定义 Open-Meteo 的响应模型
type OpenMeteoGeocodingResult = {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  admin1?: string;
  timezone?: string;
};

type OpenMeteoGeocodingResponse = {
  results?: OpenMeteoGeocodingResult[];
};

// 字符串 -> 地点列表
export async function geocodePlace(params: { query: string; count?: number }): Promise<DingtalkPlace[]> {
  // 清洗输入
  const q = params.query.trim();
  if (!q) return [];

  const resp = await axios.get<OpenMeteoGeocodingResponse>("https://geocoding-api.open-meteo.com/v1/search", {
    params: {
      name: q,
      count: params.count ?? 3,
      language: "zh",
      format: "json",
    },
    timeout: 8000,
  });

  const results = resp.data?.results ?? [];
  return results
    .map((r): DingtalkPlace | null => {
      const latitude = Number(r.latitude);
      const longitude = Number(r.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

      const name = r.name?.trim() || q;
      const label = [name, r.admin1?.trim(), r.country?.trim()].filter(Boolean).join(" · ");
      const timezone = r.timezone?.trim() || "UTC";

      return { query: q, label, latitude, longitude, timezone };
    })
    .filter((x): x is DingtalkPlace => Boolean(x));
}

export type OpenMeteoForecastPayload = any;

export async function fetchForecast(params: { place: DingtalkPlace }): Promise<OpenMeteoForecastPayload> {
  const { place } = params;

  const currentFields = [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "is_day",
    "precipitation",
    "rain",
    "showers",
    "snowfall",
    "weather_code",
    "cloud_cover",
    "pressure_msl",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
  ].join(",");

  const dailyFields = [
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "rain_sum",
    "showers_sum",
    "snowfall_sum",
    "precipitation_probability_max",
    "sunrise",
    "sunset",
    "uv_index_max",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
    "wind_direction_10m_dominant",
  ].join(",");

  // IO请求 Open-Meteo
  const resp = await axios.get("https://api.open-meteo.com/v1/forecast", {
    params: {
      latitude: place.latitude,
      longitude: place.longitude,
      timezone: place.timezone,
      current: currentFields,
      daily: dailyFields,
    },
    timeout: 8000,
  });

  return resp.data;
}

function wmoWeatherCodeToZh(code: number): string {
  // 简化映射（Open‑Meteo 使用 WMO weather interpretation codes）。
  if (code === 0) return "晴";
  if (code === 1) return "大部晴朗";
  if (code === 2) return "多云";
  if (code === 3) return "阴";
  if (code === 45 || code === 48) return "雾";
  if (code >= 51 && code <= 57) return "毛毛雨";
  if (code >= 61 && code <= 67) return "雨";
  if (code >= 71 && code <= 77) return "雪";
  if (code >= 80 && code <= 82) return "阵雨";
  if (code >= 95 && code <= 99) return "雷暴";
  return `天气码${code}`;
}

function formatValueWithUnit(value: unknown, unit: unknown): string {
  if (value === null || value === undefined) return "-";
  const u = typeof unit === "string" ? unit : "";
  return `${String(value)}${u ? ` ${u}` : ""}`;
}

function formatKeyValueLines(params: {
  title: string;
  values: Record<string, unknown> | undefined;
  units: Record<string, unknown> | undefined;
  pickIndex?: number;
}): string[] {
  const values = params.values ?? {};
  const units = params.units ?? {};

  const keys = Object.keys(values).filter((k) => k !== "time").sort();
  if (keys.length === 0) return [];

  const lines: string[] = [];
  lines.push(params.title);
  for (const key of keys) {
    const raw = values[key];
    const value =
      typeof params.pickIndex === "number" && Array.isArray(raw) ? raw[params.pickIndex] : raw;
    const unit =
      typeof params.pickIndex === "number" && Array.isArray(units[key]) ? (units as any)[key]?.[params.pickIndex] : units[key];

    lines.push(`${key}: ${formatValueWithUnit(value, unit)}`);
  }
  return lines;
}

function formatPlaceBrief(place: DingtalkPlace): string {
  const parts = place.label
    .split(" · ")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}·${parts[1]}`;
  if (parts.length >= 1) return parts[0];
  return place.query?.trim() || place.label || "";
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function trimTrailingZeros(raw: string): string {
  if (!raw.includes(".")) return raw;
  return raw.replace(/0+$/, "").replace(/\.$/, "");
}

function formatNumber(value: unknown, digits: number): string | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return trimTrailingZeros(n.toFixed(digits));
}

function normalizeTempUnit(unit: unknown): string {
  const u = typeof unit === "string" ? unit : "";
  if (u.includes("°C") || u.includes("℃")) return "℃";
  return u;
}

function formatTemp(value: unknown, unit: unknown, digits = 1): string | null {
  const n = formatNumber(value, digits);
  if (n === null) return null;
  const u = normalizeTempUnit(unit);
  return `${n}${u || ""}`.trim();
}

function formatTempRange(minValue: unknown, maxValue: unknown, unit: unknown): string | null {
  const min = formatNumber(minValue, 1);
  const max = formatNumber(maxValue, 1);
  if (min === null || max === null) return null;
  const u = normalizeTempUnit(unit);
  return `${min}～${max}${u || ""}`.trim();
}

function formatPercent(value: unknown, digits = 0): string | null {
  const n = formatNumber(value, digits);
  if (n === null) return null;
  return `${n}%`;
}

function pickIndexValue(source: Record<string, unknown> | undefined, key: string, index: number): unknown {
  const raw = (source as any)?.[key];
  if (Array.isArray(raw)) return raw[index];
  return raw;
}

function formatIsoTimeHHmm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const idx = value.indexOf("T");
  if (idx < 0) return null;
  const timePart = value.slice(idx + 1);
  const m = timePart.match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

function uvLevelZh(uv: number): string {
  if (!Number.isFinite(uv)) return "";
  if (uv < 3) return "弱";
  if (uv < 6) return "中等";
  if (uv < 8) return "中等偏强";
  if (uv < 11) return "强";
  return "极强";
}

export function formatForecastSummaryText(params: {
  place: DingtalkPlace;
  forecast: OpenMeteoForecastPayload;
  title?: string;
  includeDetailHint?: boolean;
}): string {
  const { place, forecast } = params;

  const current = forecast?.current as Record<string, unknown> | undefined;
  const currentUnits = forecast?.current_units as Record<string, unknown> | undefined;
  const daily = forecast?.daily as Record<string, unknown> | undefined;
  const dailyUnits = forecast?.daily_units as Record<string, unknown> | undefined;

  const placeBrief = formatPlaceBrief(place);
  const title = params.title ?? "天气预览";
  const header = placeBrief ? `${title}（${placeBrief}）` : title;

  const lines: string[] = [header];

  // 现在
  const code = toFiniteNumber((current as any)?.weather_code);
  const desc = code !== null ? wmoWeatherCodeToZh(Math.round(code)) : "";
  const temp = formatTemp((current as any)?.temperature_2m, (currentUnits as any)?.temperature_2m, 1);
  const feels = formatTemp(
    (current as any)?.apparent_temperature,
    (currentUnits as any)?.apparent_temperature,
    1
  );
  const rh = formatPercent((current as any)?.relative_humidity_2m, 0);

  const nowHead = desc && temp ? `${desc}，${temp}` : desc || temp || "";
  const nowLine = nowHead || feels || rh
    ? `现在：${nowHead}${feels ? `（体感 ${feels}）` : ""}${rh ? `，湿度 ${rh}` : ""}`
    : "";
  if (nowLine) lines.push(nowLine);

  // 今天
  const tMin = pickIndexValue(daily, "temperature_2m_min", 0);
  const tMax = pickIndexValue(daily, "temperature_2m_max", 0);
  const tUnit =
    (dailyUnits as any)?.temperature_2m_max ??
    (dailyUnits as any)?.temperature_2m_min ??
    (currentUnits as any)?.temperature_2m;
  const range = formatTempRange(tMin, tMax, tUnit);
  const pop = formatPercent(pickIndexValue(daily, "precipitation_probability_max", 0), 0);

  const uvRaw = pickIndexValue(daily, "uv_index_max", 0);
  const uvNum = toFiniteNumber(uvRaw);
  const uvValue = formatNumber(uvRaw, 0);
  const uvLevel = uvNum === null ? "" : uvLevelZh(uvNum);
  const uvText = uvValue ? `紫外线最高 ${uvValue}${uvLevel ? `（${uvLevel}）` : ""}` : "";

  const todayParts: string[] = [];
  if (range) todayParts.push(range);
  if (pop) todayParts.push(`降雨概率 ${pop}`);
  if (uvText) todayParts.push(uvText);
  if (todayParts.length > 0) lines.push(`今天：${todayParts.join("，")}`);

  // 日出/日落
  const sunrise = formatIsoTimeHHmm(pickIndexValue(daily, "sunrise", 0));
  const sunset = formatIsoTimeHHmm(pickIndexValue(daily, "sunset", 0));
  if (sunrise && sunset) lines.push(`日出 ${sunrise} / 日落 ${sunset}`);
  else if (sunrise) lines.push(`日出 ${sunrise}`);
  else if (sunset) lines.push(`日落 ${sunset}`);

  lines.push("数据源：Open-Meteo");
  if (params.includeDetailHint !== false) {
    lines.push("（回复“详情”可查看完整指标）");
  }

  return lines.join("\n").slice(0, 1200);
}

export function formatForecastText(params: {
  place: DingtalkPlace;
  forecast: OpenMeteoForecastPayload;
  title?: string;
}): string {
  const { place, forecast } = params;

  const currentTime = forecast?.current?.time ?? "";
  const current = forecast?.current as Record<string, unknown> | undefined;
  const currentUnits = forecast?.current_units as Record<string, unknown> | undefined;

  const daily = forecast?.daily as Record<string, unknown> | undefined;
  const dailyUnits = forecast?.daily_units as Record<string, unknown> | undefined;
  const dailyTimes: unknown = daily?.time;
  const todayLabel =
    Array.isArray(dailyTimes) && typeof dailyTimes[0] === "string" ? String(dailyTimes[0]) : "";

  const lines: string[] = [];
  lines.push(params.title ?? "天气订阅推送");
  lines.push(`地点：${place.label}`);
  if (place.timezone) lines.push(`时区：${place.timezone}`);
  if (currentTime) lines.push(`本地时间：${currentTime}`);

  // 如果有 weather_code，补充一行更易读的天气描述。
  const code = Number((current as any)?.weather_code);
  if (Number.isFinite(code)) {
    lines.push(`天气：${wmoWeatherCodeToZh(code)}（weather_code=${code}）`);
  }

  // 额外给一行更像“人”的摘要（不影响下面的完整字段输出）。
  const summaryParts: string[] = [];
  const t2m = (current as any)?.temperature_2m;
  const feels = (current as any)?.apparent_temperature;
  const rh = (current as any)?.relative_humidity_2m;
  const wind = (current as any)?.wind_speed_10m;
  const t2mUnit = (currentUnits as any)?.temperature_2m;
  const feelsUnit = (currentUnits as any)?.apparent_temperature;
  const rhUnit = (currentUnits as any)?.relative_humidity_2m;
  const windUnit = (currentUnits as any)?.wind_speed_10m;

  if (t2m !== undefined) summaryParts.push(`温度 ${formatValueWithUnit(t2m, t2mUnit)}`);
  if (feels !== undefined) summaryParts.push(`体感 ${formatValueWithUnit(feels, feelsUnit)}`);
  if (rh !== undefined) summaryParts.push(`湿度 ${formatValueWithUnit(rh, rhUnit)}`);
  if (wind !== undefined) summaryParts.push(`风速 ${formatValueWithUnit(wind, windUnit)}`);
  if (summaryParts.length > 0) {
    lines.push(`摘要：${summaryParts.join("，")}`);
  }

  lines.push("");
  lines.push(...formatKeyValueLines({ title: "【当前】", values: current, units: currentUnits }));

  if (todayLabel) {
    lines.push("");
    lines.push(`【今日】(${todayLabel})`);
    lines.push(
      ...formatKeyValueLines({ title: "", values: daily, units: dailyUnits, pickIndex: 0 }).filter(
        (x) => x.trim().length > 0
      )
    );
  }

  lines.push("");
  lines.push("数据来源：Open-Meteo");

  // 控制消息长度：钉钉文本消息有长度限制。
  return lines.join("\n").slice(0, 3500);
}
