import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDingtalkRuntime } from "./runtime.js";
import type { DingtalkSubscriptionStoreV1, DingtalkWeatherSubscription } from "./subscription-types.js";

const STORE_VERSION = 1 as const;

export type DingtalkSubscriptionStorePathOptions = {
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

export function resolveDingtalkSubscriptionStorePath(
  params: DingtalkSubscriptionStorePathOptions
): string {
  if (params.storePath) return params.storePath;

  const accountId = normalizeAccountId(params.accountId);
  const filename = `subscriptions-${accountId}.json`;

  if (params.stateDir) return path.join(params.stateDir, "dingtalk", filename);

  const env = params.env ?? process.env;
  const stateDir = params.homedir
    ? getDingtalkRuntime().state.resolveStateDir(env, params.homedir)
    : getDingtalkRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "dingtalk", filename);
}

function emptyStore(): DingtalkSubscriptionStoreV1 {
  return { version: STORE_VERSION, subscriptions: {} };
}

function safeParseStore(raw: string): DingtalkSubscriptionStoreV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DingtalkSubscriptionStoreV1>;
    if (parsed?.version !== STORE_VERSION) return null;
    if (!parsed.subscriptions || typeof parsed.subscriptions !== "object") return null;
    return {
      version: STORE_VERSION,
      subscriptions: parsed.subscriptions as Record<string, DingtalkWeatherSubscription>,
    };
  } catch {
    return null;
  }
}

export async function readDingtalkSubscriptionStore(
  params: DingtalkSubscriptionStorePathOptions
): Promise<DingtalkSubscriptionStoreV1> {
  const filePath = resolveDingtalkSubscriptionStorePath(params);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseStore(raw) ?? emptyStore();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return emptyStore();
    return emptyStore();
  }
}

export async function writeDingtalkSubscriptionStore(params: {
  store: DingtalkSubscriptionStoreV1;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): Promise<void> {
  const filePath = resolveDingtalkSubscriptionStorePath(params);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(params.store, null, 2)}\n`, { encoding: "utf-8" });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

export async function getDingtalkSubscription(params: {
  userId: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DingtalkWeatherSubscription | null> {
  const store = await readDingtalkSubscriptionStore({
    accountId: params.accountId,
    env: params.env,
  });
  return store.subscriptions[params.userId] ?? null;
}

export async function upsertDingtalkSubscription(params: {
  subscription: DingtalkWeatherSubscription;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const store = await readDingtalkSubscriptionStore({
    accountId: params.accountId,
    env: params.env,
  });
  store.subscriptions[params.subscription.userId] = params.subscription;
  await writeDingtalkSubscriptionStore({
    store,
    accountId: params.accountId,
    env: params.env,
  });
}

export async function deleteDingtalkSubscription(params: {
  userId: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const store = await readDingtalkSubscriptionStore({
    accountId: params.accountId,
    env: params.env,
  });
  const existed = Boolean(store.subscriptions[params.userId]);
  delete store.subscriptions[params.userId];
  await writeDingtalkSubscriptionStore({
    store,
    accountId: params.accountId,
    env: params.env,
  });
  return existed;
}

