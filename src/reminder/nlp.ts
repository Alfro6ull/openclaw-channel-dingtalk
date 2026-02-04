// 从自然语言里尽量提取：一次性提醒的时间（HH:mm）与内容。

const ZH_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function normalizeText(input: string): string {
  // 把常见的全角数字/冒号转换为半角，降低输入差异带来的解析失败概率。
  return input
    .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - "０".charCodeAt(0)))
    .replace(/[：]/g, ":")
    .trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function parseZhInt(raw: string): number | null {
  const s = raw.trim().replace(/两/g, "二");
  if (!s) return null;

  // 纯数字（例如 "8"、"30"）
  if (/^\d+$/.test(s)) return Number(s);

  // 单个汉字（例如 "八"）
  if (s.length === 1 && s in ZH_DIGIT) return ZH_DIGIT[s];

  // 处理带“十”的 10-99（例如 "十八"、"二十三"）
  const idx = s.indexOf("十");
  if (idx >= 0) {
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx + 1).trim();

    const tens = left ? (left in ZH_DIGIT ? ZH_DIGIT[left] : null) : 1;
    if (tens === null) return null;
    const ones = right ? (right in ZH_DIGIT ? ZH_DIGIT[right] : null) : 0;
    if (ones === null) return null;
    return tens * 10 + ones;
  }

  // 兜底：逐字拼接（例如 "二三" => 23）
  if ([...s].every((ch) => ch in ZH_DIGIT)) {
    return Number([...s].map((ch) => String(ZH_DIGIT[ch])).join(""));
  }

  return null;
}

type TimeMatch = {
  hour: number;
  minute: number;
  start: number;
  end: number;
};

function applyPeriodHint(hour: number, period: string): number {
  const isPm = /下午|晚上|傍晚|夜里/.test(period);
  const isNoon = /中午/.test(period);
  const isDawn = /凌晨/.test(period);

  let h = hour;
  if (isPm || isNoon) {
    if (h < 12) h += 12;
  }
  if (isDawn) {
    if (h === 12) h = 0;
  }
  // 常见口语：很多人说“晚上12点”指的是 00:00。
  if (isPm && h === 12 && /12/.test(String(hour))) {
    h = 0;
  }
  return h;
}

function findTimeMatches(text: string): TimeMatch[] {
  const matches: TimeMatch[] = [];

  // 1) HH:mm（例如 8:00 / 08:00 / 18:30）
  const reColon = /(\d{1,2})\s*:\s*(\d{1,2})/g;
  for (const m of text.matchAll(reColon)) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59
    ) {
      matches.push({ hour, minute, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }

  // 2) 中文/数字：xx点 / xx点半 / xx点xx分
  const reDot =
    /(凌晨|早上|上午|中午|下午|晚上|傍晚|夜里)?\s*([0-9零〇一二两三四五六七八九十]{1,3})\s*点\s*(半|([0-9零〇一二两三四五六七八九十]{1,3})\s*(分|分钟)?)?/g;
  for (const m of text.matchAll(reDot)) {
    const period = m[1] ?? "";
    const hourRaw = m[2] ?? "";
    const minutePart = m[3] ?? "";

    const hourParsed = parseZhInt(hourRaw);
    if (hourParsed === null) continue;

    let minuteParsed = 0;
    if (minutePart) {
      if (minutePart.includes("半")) {
        minuteParsed = 30;
      } else {
        const minuteRaw = (m[4] ?? "").trim();
        const parsed = parseZhInt(minuteRaw);
        if (parsed === null) continue;
        minuteParsed = parsed;
      }
    }

    let hour = applyPeriodHint(hourParsed, period);
    const minute = minuteParsed;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
    matches.push({ hour, minute, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }

  return matches.sort((a, b) => a.start - b.start);
}

function parseDayOffset(text: string): number {
  const t = text.trim();
  if (/后天/.test(t)) return 2;
  if (/明天/.test(t)) return 1;
  return 0;
}

function stripReminderNoise(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[，,。.!！？?]/g, " ")
    .replace(/(提醒我|提醒一下|提醒|叫我|闹钟|到点|帮我|请|麻烦|一下|的时候|时候|在)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ParseReminderResult =
  | { kind: "ok"; hour: number; minute: number; timeHHmm: string; dayOffset: number; message: string }
  | { kind: "need_time"; message: string }
  | { kind: "multiple_times" };

export function parseReminderFromText(input: string): ParseReminderResult {
  const text = normalizeText(input);
  const dayOffset = parseDayOffset(text);
  const matches = findTimeMatches(text);

  if (matches.length >= 2) return { kind: "multiple_times" };

  if (matches.length === 0) {
    const message = stripReminderNoise(text.replace(/今天|明天|后天/g, " "));
    return { kind: "need_time", message };
  }

  const m = matches[0];
  const timeHHmm = `${pad2(m.hour)}:${pad2(m.minute)}`;
  const messagePart = `${text.slice(0, m.start)} ${text.slice(m.end)}`.replace(/今天|明天|后天/g, " ");
  const message = stripReminderNoise(messagePart);

  return {
    kind: "ok",
    hour: m.hour,
    minute: m.minute,
    timeHHmm,
    dayOffset,
    message,
  };
}

