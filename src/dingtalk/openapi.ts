import axios from "axios";

export type DingtalkOpenApiClientOptions = {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

type AccessTokenResponse = {
  accessToken?: string;
  expireIn?: number;
};

type CalendarListResponse = {
  response?: {
    calendars?: Array<{
      calendarId?: string;
      calendarName?: string;
      calendarType?: string;
      timeZone?: string;
    }>;
  };
  calendars?: Array<{
    calendarId?: string;
    calendarName?: string;
    calendarType?: string;
    timeZone?: string;
  }>;
};

type EventsViewResponse = {
  events?: Array<{
    id?: string;
    summary?: string;
    isAllDay?: boolean;
    start?: { dateTime?: string; timeZone?: string };
    end?: { dateTime?: string; timeZone?: string };
    location?: { displayName?: string };
  }>;
  nextToken?: string;
  response?: {
    events?: Array<{
      id?: string;
      summary?: string;
      isAllDay?: boolean;
      start?: { dateTime?: string; timeZone?: string };
      end?: { dateTime?: string; timeZone?: string };
      location?: { displayName?: string };
    }>;
    nextToken?: string;
  };
};

export class DingtalkOpenApiClient {
  private accessToken: string | null = null;
  private expiresAtMs: number = 0;
  private inflightTokenPromise: Promise<string> | null = null;

  constructor(private readonly opts: DingtalkOpenApiClientOptions) {}

  private apiHost(): string {
    return "https://api.dingtalk.com";
  }

  private async fetchAccessToken(): Promise<string> {
    const { clientId, clientSecret } = this.opts;
    const resp = await axios.post<AccessTokenResponse>(
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      { appKey: clientId, appSecret: clientSecret },
      { timeout: 8000 }
    );

    const token = resp.data?.accessToken;
    const expireIn = Number(resp.data?.expireIn ?? 0);
    if (!token) throw new Error("dingtalk_access_token_missing");

    // expireIn 的单位是秒；这里留一点安全余量，避免临界点过期。
    const marginMs = 60_000;
    this.accessToken = token;
    this.expiresAtMs = Date.now() + Math.max(0, expireIn * 1000 - marginMs);
    return token;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAtMs) return this.accessToken;
    if (this.inflightTokenPromise) return this.inflightTokenPromise;

    this.inflightTokenPromise = this.fetchAccessToken()
      .catch((err) => {
        this.opts.log?.warn?.(`[dingtalk] failed to fetch accessToken: ${String(err?.message ?? err)}`);
        throw err;
      })
      .finally(() => {
        this.inflightTokenPromise = null;
      });

    return this.inflightTokenPromise;
  }

  private async request<T>(params: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }): Promise<T> {
    const accessToken = await this.getAccessToken();
    const url = `${this.apiHost()}${params.path}`;
    const resp = await axios.request<T>({
      method: params.method,
      url,
      params: params.query,
      data: params.body,
      timeout: 8000,
      headers: {
        "x-acs-dingtalk-access-token": accessToken,
        "content-type": "application/json",
      },
    });
    return resp.data;
  }

  async sendTextToUsers(params: { userIds: string[]; text: string }): Promise<void> {
    const { robotCode } = this.opts;
    const accessToken = await this.getAccessToken();

    const userIds = params.userIds
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (userIds.length === 0) return;

    await axios.post(
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      {
        robotCode,
        userIds,
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content: params.text }),
      },
      {
        timeout: 8000,
        headers: {
          "x-acs-dingtalk-access-token": accessToken,
          "content-type": "application/json",
        },
      }
    );
  }

  async sendTextToUser(params: { userId: string; text: string }): Promise<void> {
    await this.sendTextToUsers({ userIds: [params.userId], text: params.text });
  }

  async listCalendars(params: { userId: string }): Promise<{
    calendars: Array<{ calendarId: string; calendarName?: string; calendarType?: string; timeZone?: string }>;
  }> {
    const userId = params.userId.trim();
    if (!userId) return { calendars: [] };

    const data = await this.request<CalendarListResponse>({
      method: "GET",
      path: `/v1.0/calendar/users/${encodeURIComponent(userId)}/calendars`,
    });
    const calendars = (data.response?.calendars ?? data.calendars ?? [])
      .map((c) => ({
        calendarId: String(c.calendarId || "").trim(),
        calendarName: c.calendarName,
        calendarType: c.calendarType,
        timeZone: c.timeZone,
      }))
      .filter((c) => c.calendarId);
    return { calendars };
  }

  async listEventsView(params: {
    userId: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    nextToken?: string;
    maxResults?: number;
  }): Promise<{
    events: Array<{
      id?: string;
      summary?: string;
      isAllDay?: boolean;
      start?: { dateTime?: string; timeZone?: string };
      end?: { dateTime?: string; timeZone?: string };
      location?: { displayName?: string };
    }>;
    nextToken?: string;
  }> {
    const userId = params.userId.trim();
    const calendarId = params.calendarId.trim();
    if (!userId || !calendarId) return { events: [] };

    const data = await this.request<EventsViewResponse>({
      method: "GET",
      path: `/v1.0/calendar/users/${encodeURIComponent(userId)}/calendars/${encodeURIComponent(calendarId)}/eventsview`,
      query: {
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        nextToken: params.nextToken,
        maxResults: params.maxResults,
      },
    });
    const events = (data.response?.events ?? data.events ?? []) ?? [];
    const nextToken = data.response?.nextToken ?? data.nextToken;
    return { events, nextToken };
  }
}
