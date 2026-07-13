import { getApiKeyPolicy, getApiKeyQuotaSummary, getAdapter, reserveApiKeyQuota, settleApiKeyQuota } from "@/lib/db";
import { getModelAliases, getComboByName } from "@/lib/localDb";

export async function resolveApiKeyPolicy(rawKey) {
  const db = await getAdapter();
  const row = db.get(`SELECT id, key, name, isActive FROM apiKeys WHERE key = ?`, [rawKey]);
  if (!row || !(row.isActive === 1 || row.isActive === true)) return null;
  const policy = await getApiKeyPolicy(row.id);
  if (policy?.expiresAt && new Date(policy.expiresAt).getTime() <= Date.now()) return null;
  return { key: { id: row.id, name: row.name || "API key" }, policy };
}

export function policyError(status, code, message, retryAfter = null) {
  return { status, code, message, retryAfter };
}

export async function checkModelAccess({ policy, model }) {
  const allowed = policy?.allowedModels || [];
  if (!allowed.length) return null;
  if (allowed.includes(model)) return null;
  const combo = await getComboByName(model);
  if (combo && allowed.includes(model)) return null;
  const aliases = await getModelAliases();
  const target = aliases?.[model];
  if (target && allowed.includes(target)) return null;
  return policyError(403, "model_not_allowed", "Model is not allowed for this API key");
}

function estimateTokens(body) {
  const ceiling = Number(body?.max_tokens ?? body?.max_completion_tokens ?? body?.generationConfig?.maxOutputTokens ?? 0);
  return Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : 0;
}

export async function enforceApiKeyPolicy({ apiKey, model, body, endpoint }) {
  if (!apiKey) return { context: null, error: null };
  const resolved = await resolveApiKeyPolicy(apiKey);
  if (!resolved) return { context: null, error: policyError(401, "invalid_api_key", "Invalid, disabled, or expired API key") };
  const accessError = await checkModelAccess({ policy: resolved.policy, model });
  if (accessError) return { context: null, error: accessError };
  const quota = await reserveApiKeyQuota({ keyId: resolved.key.id, policy: resolved.policy, estimatedTokens: estimateTokens(body), endpoint, model });
  return quota.error ? { context: null, error: quota.error } : { context: { keyId: resolved.key.id, reservationId: quota.reservationId, policy: resolved.policy }, error: null };
}

export async function settleApiKeyPolicy(context, usage) {
  if (context?.reservationId) await settleApiKeyQuota({ reservationId: context.reservationId, usage });
}

export function filterModelsByApiKeyPolicy(models, policy) {
  const allowed = policy?.allowedModels || [];
  if (!allowed.length) return models;
  return models.filter((model) => allowed.includes(model.id) || allowed.includes(model.owned_by));
}

export async function getApiKeyPolicySummary(key) {
  const policy = await getApiKeyPolicy(key.id);
  const quota = await getApiKeyQuotaSummary(key.id, policy);
  return { policy: policy || { allowedModels: [], dailyTokenLimit: null, lifetimeTokenLimit: null, expiresAt: null }, quota: { state: key.isActive ? (policy?.expiresAt && new Date(policy.expiresAt) <= new Date() ? "expired" : "active") : "disabled", ...quota } };
}
