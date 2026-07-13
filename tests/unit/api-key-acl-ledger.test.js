import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-acl-ledger-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key quota ledger", () => {
  it("reserves atomically, blocks cap overflow, and releases unused capacity on settlement", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { getApiKeyPolicy } = await import("@/lib/db/repos/apiKeyAclRepo.js");
    const { getApiKeyQuotaSummary, reserveApiKeyQuota, settleApiKeyQuota } = await import("@/lib/db/repos/quotaRepo.js");
    const key = await createApiKey("test", "machine", { dailyTokenLimit: 100, lifetimeTokenLimit: 100, allowedModels: ["devin/swe-1-6-slow"] });
    const policy = await getApiKeyPolicy(key.id);

    const first = await reserveApiKeyQuota({ keyId: key.id, policy, estimatedTokens: 80, endpoint: "/v1/chat/completions", model: "devin/swe-1-6-slow" });
    expect(first.reservationId).toBeTruthy();
    const rejected = await reserveApiKeyQuota({ keyId: key.id, policy, estimatedTokens: 21 });
    expect(rejected.error).toMatchObject({ status: 429, code: "token_quota_exceeded" });

    await settleApiKeyQuota({ reservationId: first.reservationId, usage: { prompt_tokens: 20, completion_tokens: 10 } });
    const summary = await getApiKeyQuotaSummary(key.id, policy);
    expect(summary.daily).toMatchObject({ used: 30, reserved: 0, remaining: 70 });

    const second = await reserveApiKeyQuota({ keyId: key.id, policy, estimatedTokens: 70 });
    expect(second.reservationId).toBeTruthy();
  });

  it("charges a reservation conservatively when stream usage is unavailable", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const { getApiKeyPolicy } = await import("@/lib/db/repos/apiKeyAclRepo.js");
    const { getApiKeyQuotaSummary, reserveApiKeyQuota, settleApiKeyQuota } = await import("@/lib/db/repos/quotaRepo.js");
    const key = await createApiKey("test", "machine", { lifetimeTokenLimit: 50 });
    const policy = await getApiKeyPolicy(key.id);
    const reserved = await reserveApiKeyQuota({ keyId: key.id, policy, estimatedTokens: 40 });
    await settleApiKeyQuota({ reservationId: reserved.reservationId });
    const summary = await getApiKeyQuotaSummary(key.id, policy);
    expect(summary.lifetime).toMatchObject({ used: 40, reserved: 0, remaining: 10 });
  });
});
