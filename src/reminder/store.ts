import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDingtalkRuntime } from "../runtime.js";
import type { DingtalkReminder, DingtalkReminderStoreV1 } from "./types.js";

const STORE_VERSION = 1 as const;

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

function emptyStore(): DingtalkReminderStoreV1 {
  return { version: STORE_VERSION, reminders: {} };
}

function safeParseStore(raw: string): DingtalkReminderStoreV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DingtalkReminderStoreV1>;
    if (parsed?.version !== STORE_VERSION) return null;
    if (!parsed.reminders || typeof parsed.reminders !== "object") return null;
    return {
      version: STORE_VERSION,
      reminders: parsed.reminders as Record<string, DingtalkReminder>,
    };
  } catch {
    return null;
  }
}

export async function readDingtalkReminderStore(params: DingtalkReminderStorePathOptions): Promise<DingtalkReminderStoreV1> {
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
  store: DingtalkReminderStoreV1;
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
  delete store.reminders[params.id];
  await writeDingtalkReminderStore({ store, accountId: params.accountId });
  return true;
}

