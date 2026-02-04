import axios from "axios";

import type { DingtalkPlace } from "./subscription-types.js";

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

export async function geocodePlace(params: { query: string; count?: number }): Promise<DingtalkPlace[]> {
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

export function formatForecastText(params: {
  place: DingtalkPlace;
  forecast: OpenMeteoForecastPayload;
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
  lines.push("天气订阅推送");
  lines.push(`地点：${place.label}`);
  if (place.timezone) lines.push(`时区：${place.timezone}`);
  if (currentTime) lines.push(`本地时间：${currentTime}`);

  // 如果有 weather_code，补充一行更易读的天气描述。
  const code = Number((current as any)?.weather_code);
  if (Number.isFinite(code)) {
    lines.push(`天气：${wmoWeatherCodeToZh(code)}（weather_code=${code}）`);
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
