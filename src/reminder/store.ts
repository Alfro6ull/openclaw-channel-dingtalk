import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDingtalkRuntime } from "../runtime.js";
import type {
  DingtalkReminder,
  DingtalkReminderAckAction,
  DingtalkReminderStoreV1,
  DingtalkReminderStoreV2,
} from "./types.js";

const STORE_VERSION = 2 as const;

export type DingtalkReminderStorePathOptions = {
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

export function resolveDingtalkReminderStorePath(params: DingtalkReminderStorePathOptions): string {
  if (params.storePath) return params.storePath;

  const accountId = normalizeAccountId(params.accountId);
  const filename = `reminders-${accountId}.json`;

  if (params.stateDir) return path.join(params.stateDir, "dingtalk", filename);

  const env = params.env ?? process.env;
  const stateDir = params.homedir
    ? getDingtalkRuntime().state.resolveStateDir(env, params.homedir)
    : getDingtalkRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "dingtalk", filename);
}

function emptyStore(): DingtalkReminderStoreV2 {
  return { version: STORE_VERSION, reminders: {}, lastSentReminderIdByUser: {} };
}

function safeParseStore(raw: string): DingtalkReminderStoreV2 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DingtalkReminderStoreV1 & DingtalkReminderStoreV2>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.reminders || typeof parsed.reminders !== "object") return null;

    if (parsed.version === 1) {
      return {
        version: STORE_VERSION,
        reminders: parsed.reminders as Record<string, DingtalkReminder>,
        lastSentReminderIdByUser: {},
      };
    }

    if (parsed.version !== STORE_VERSION) return null;
    return {
      version: STORE_VERSION,
      reminders: parsed.reminders as Record<string, DingtalkReminder>,
      lastSentReminderIdByUser:
        parsed.lastSentReminderIdByUser && typeof parsed.lastSentReminderIdByUser === "object"
          ? (parsed.lastSentReminderIdByUser as Record<string, string>)
          : {},
    };
  } catch {
    return null;
  }
}

export async function readDingtalkReminderStore(
  params: DingtalkReminderStorePathOptions
): Promise<DingtalkReminderStoreV2> {
  const filePath = resolveDingtalkReminderStorePath(params);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseStore(raw) ?? emptyStore();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return emptyStore();
    return emptyStore();
  }
}

export async function writeDingtalkReminderStore(params: {
  store: DingtalkReminderStoreV2;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): Promise<void> {
  const filePath = resolveDingtalkReminderStorePath(params);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(params.store, null, 2)}\n`, { encoding: "utf-8" });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

export async function addDingtalkReminder(params: { reminder: DingtalkReminder; accountId?: string }): Promise<void> {
  const store = await readDingtalkReminderStore({ accountId: params.accountId });
  store.reminders[params.reminder.id] = params.reminder;
  await writeDingtalkReminderStore({ store, accountId: params.accountId });
}

export async function listDingtalkReminders(params: { userId: string; accountId?: string }): Promise<DingtalkReminder[]> {
  const store = await readDingtalkReminderStore({ accountId: params.accountId });
  return Object.values(store.reminders)
    .filter((r) => r.userId === params.userId && !r.canceledAtMs && !r.sentAtMs)
    .sort((a, b) => a.scheduledAtMs - b.scheduledAtMs);
}

export async function cancelDingtalkReminder(params: {
  id: string;
  userId: string;
  accountId?: string;
}): Promise<boolean> {
  const store = await readDingtalkReminderStore({ accountId: params.accountId });
  const existing = store.reminders[params.id];
  if (!existing) return false;
  if (existing.userId !== params.userId) return false;
  const nowMs = Date.now();
  store.reminders[params.id] = {
    ...existing,
    canceledAtMs: existing.canceledAtMs ?? nowMs,
    acknowledgedAtMs: existing.acknowledgedAtMs ?? nowMs,
    ackAction: existing.ackAction ?? "canceled",
  };
  await writeDingtalkReminderStore({ store, accountId: params.accountId });
  return true;
}

export async function markReminderSent(params: {
  id: string;
  userId: string;
  sentAtMs: number;
  accountId?: string;
}): Promise<void> {
  const store = await readDingtalkReminderStore({ accountId: params.accountId });
  const existing = store.reminders[params.id];
  if (!existing) return;
  if (existing.userId !== params.userId) return;
  store.reminders[params.id] = { ...existing, sentAtMs: params.sentAtMs };
  store.lastSentReminderIdByUser[params.userId] = params.id;
  await writeDingtalkReminderStore({ store, accountId: params.accountId });
}

export async function resolveLastSentReminderId(params: {
  userId: string;
  accountId?: string;
}): Promise<string | null> {
  const store = await readDingtalkReminderStore({ accountId: params.accountId });
  const id = store.lastSentReminderIdByUser[params.userId];
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export async function getDingtalkReminder(params: { id: string; accountId?: string }): Promise<DingtalkReminder | null> {
  const store = await readDingtalkReminderStore({ accountId: params.accountId });
  return store.reminders[params.id] ?? null;
}

export async function ackDingtalkReminder(params: {
  id: string;
  userId: string;
  action: DingtalkReminderAckAction;
  acknowledgedAtMs: number;
  accountId?: string;
  nextReminderId?: string;
}): Promise<boolean> {
  const store = await readDingtalkReminderStore({ accountId: params.accountId });
  const existing = store.reminders[params.id];
  if (!existing) return false;
  if (existing.userId !== params.userId) return false;

  const updated: DingtalkReminder = {
    ...existing,
    acknowledgedAtMs: params.acknowledgedAtMs,
    ackAction: params.action,
    nextReminderId: params.nextReminderId ?? existing.nextReminderId,
  };
  if (params.action === "canceled") {
    updated.canceledAtMs = updated.canceledAtMs ?? params.acknowledgedAtMs;
  }

  store.reminders[params.id] = updated;
  await writeDingtalkReminderStore({ store, accountId: params.accountId });
  return true;
}
