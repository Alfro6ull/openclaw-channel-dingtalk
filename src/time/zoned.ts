// 时区相关的时间工具（不依赖 Temporal）。

type ZonedParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }
  return {
    year: lookup.year ?? "1970",
    month: lookup.month ?? "01",
    day: lookup.day ?? "01",
    hour: lookup.hour ?? "00",
    minute: lookup.minute ?? "00",
    second: lookup.second ?? "00",
  };
}

export function addDaysToYmd(ymd: { year: string; month: string; day: string }, dayOffset: number): {
  year: string;
  month: string;
  day: string;
} {
  const y = Number(ymd.year);
  const m = Number(ymd.month);
  const d = Number(ymd.day);

  // 用 UTC 的“中午”避免夏令时边界导致的日期漂移。
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return {
    year: String(base.getUTCFullYear()),
    month: pad2(base.getUTCMonth() + 1),
    day: pad2(base.getUTCDate()),
  };
}

function toDateUtcMs(ymd: { year: string; month: string; day: string }): number {
  return Date.UTC(Number(ymd.year), Number(ymd.month) - 1, Number(ymd.day));
}

export function zonedLocalToUtcMs(params: {
  timeZone: string;
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second?: string;
}): number {
  const desired = {
    year: params.year,
    month: params.month,
    day: params.day,
    hour: params.hour,
    minute: params.minute,
    second: params.second ?? "00",
  };

  // 初始猜测：把“本地时间”当成 UTC。
  let guess = Date.UTC(
    Number(desired.year),
    Number(desired.month) - 1,
    Number(desired.day),
    Number(desired.hour),
    Number(desired.minute),
    Number(desired.second)
  );

  // 迭代修正：根据时区格式化后的结果与期望的差值，修正猜测。
  for (let i = 0; i < 4; i++) {
    const got = getZonedParts(new Date(guess), params.timeZone);

    const dayDiff = (toDateUtcMs(desired) - toDateUtcMs(got)) / 86_400_000;
    const desiredMinutes = Number(desired.hour) * 60 + Number(desired.minute);
    const gotMinutes = Number(got.hour) * 60 + Number(got.minute);
    const minuteDiff = desiredMinutes - gotMinutes;

    const totalDiffMinutes = dayDiff * 1440 + minuteDiff;
    if (totalDiffMinutes === 0) return guess;
    guess += totalDiffMinutes * 60_000;
  }

  return guess;
}

export function formatZonedYmdHm(utcMs: number, timeZone: string): string {
  const p = getZonedParts(new Date(utcMs), timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

