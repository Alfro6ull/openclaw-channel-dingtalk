import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDingtalkRuntime } from "../runtime.js";
import type { DingtalkCalendarStoreV1, DingtalkCalendarWatch } from "./types.js";

const STORE_VERSION = 1 as const;

export type DingtalkCalendarStorePathOptions = {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
};

function normalizeAccountId(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) return "default";
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

export function resolveDingtalkCalendarStorePath(params: DingtalkCalendarStorePathOptions): string {
  if (params.storePath) return params.storePath;

  const accountId = normalizeAccountId(params.accountId);
  const filename = `calendar-watch-${accountId}.json`;

  if (params.stateDir) return path.join(params.stateDir, "dingtalk", filename);

  const env = params.env ?? process.env;
  const stateDir = params.homedir
    ? getDingtalkRuntime().state.resolveStateDir(env, params.homedir)
    : getDingtalkRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "dingtalk", filename);
}

function emptyStore(): DingtalkCalendarStoreV1 {
  return {
    version: STORE_VERSION,
    watches: {},
    primaryCalendarIdByUser: {},
    notifiedKeysByUser: {},
  };
}

function safeParseStore(raw: string): DingtalkCalendarStoreV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DingtalkCalendarStoreV1>;
    if (parsed?.version !== STORE_VERSION) return null;
    if (!parsed.watches || typeof parsed.watches !== "object") return null;
    return {
      version: STORE_VERSION,
      watches: parsed.watches as Record<string, DingtalkCalendarWatch>,
      primaryCalendarIdByUser:
        parsed.primaryCalendarIdByUser && typeof parsed.primaryCalendarIdByUser === "object"
          ? (parsed.primaryCalendarIdByUser as Record<string, string>)
          : {},
      notifiedKeysByUser:
        parsed.notifiedKeysByUser && typeof parsed.notifiedKeysByUser === "object"
          ? (parsed.notifiedKeysByUser as Record<string, string[]>)
          : {},
    };
  } catch {
    return null;
  }
}

export async function readDingtalkCalendarStore(params: DingtalkCalendarStorePathOptions): Promise<DingtalkCalendarStoreV1> {
  const filePath = resolveDingtalkCalendarStorePath(params);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseStore(raw) ?? emptyStore();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return emptyStore();
    return emptyStore();
  }
}

export async function writeDingtalkCalendarStore(params: {
  store: DingtalkCalendarStoreV1;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): Promise<void> {
  const filePath = resolveDingtalkCalendarStorePath(params);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(params.store, null, 2)}\n`, { encoding: "utf-8" });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

export async function upsertCalendarWatch(params: {
  watch: DingtalkCalendarWatch;
  accountId?: string;
}): Promise<void> {
  const store = await readDingtalkCalendarStore({ accountId: params.accountId });
  store.watches[params.watch.userId] = params.watch;
  await writeDingtalkCalendarStore({ store, accountId: params.accountId });
}

export async function getCalendarWatch(params: {
  userId: string;
  accountId?: string;
}): Promise<DingtalkCalendarWatch | null> {
  const store = await readDingtalkCalendarStore({ accountId: params.accountId });
  return store.watches[params.userId] ?? null;
}

export async function listEnabledWatches(params: { accountId?: string }): Promise<DingtalkCalendarWatch[]> {
  const store = await readDingtalkCalendarStore({ accountId: params.accountId });
  return Object.values(store.watches).filter((w) => w.enabled);
}

export async function rememberPrimaryCalendarId(params: {
  userId: string;
  calendarId: string;
  accountId?: string;
}): Promise<void> {
  const store = await readDingtalkCalendarStore({ accountId: params.accountId });
  store.primaryCalendarIdByUser[params.userId] = params.calendarId;
  await writeDingtalkCalendarStore({ store, accountId: params.accountId });
}

export async function getPrimaryCalendarId(params: {
  userId: string;
  accountId?: string;
}): Promise<string | null> {
  const store = await readDingtalkCalendarStore({ accountId: params.accountId });
  const id = store.primaryCalendarIdByUser[params.userId];
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export async function markEventNotified(params: {
  userId: string;
  key: string;
  accountId?: string;
  keep?: number;
}): Promise<void> {
  const store = await readDingtalkCalendarStore({ accountId: params.accountId });
  const keep = Math.max(50, Math.min(2000, params.keep ?? 500));
  const existing = Array.isArray(store.notifiedKeysByUser[params.userId]) ? store.notifiedKeysByUser[params.userId] : [];
  const next = existing.filter((x) => x !== params.key);
  next.push(params.key);
  store.notifiedKeysByUser[params.userId] = next.slice(-keep);
  await writeDingtalkCalendarStore({ store, accountId: params.accountId });
}

export async function wasEventNotified(params: {
  userId: string;
  key: string;
  accountId?: string;
}): Promise<boolean> {
  const store = await readDingtalkCalendarStore({ accountId: params.accountId });
  const existing = store.notifiedKeysByUser[params.userId];
  return Array.isArray(existing) ? existing.includes(params.key) : false;
}

