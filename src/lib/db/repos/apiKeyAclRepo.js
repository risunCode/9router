import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MAX_TOKENS = Number.MAX_SAFE_INTEGER;

function normalizedLimit(value, name) {
  if (value == null || value === "" || value === 0 || value === "0") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_TOKENS) throw new Error(`${name} must be a non-negative safe integer`);
  return parsed;
}

function normalizedExpiry(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("expiresAt must be a valid date");
  return parsed.toISOString();
}

function normalizedModels(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("allowedModels must be an array");
  return [...new Set(value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean))];
}

export function normalizeApiKeyPolicy(value = {}) {
  return {
    allowedModels: normalizedModels(value.allowedModels),
    dailyTokenLimit: normalizedLimit(value.dailyTokenLimit, "dailyTokenLimit"),
    lifetimeTokenLimit: normalizedLimit(value.lifetimeTokenLimit, "lifetimeTokenLimit"),
    expiresAt: normalizedExpiry(value.expiresAt),
  };
}

function rowToPolicy(row) {
  if (!row) return null;
  return {
    allowedModels: parseJson(row.allowedModels, []),
    dailyTokenLimit: row.dailyTokenLimit == null ? null : Number(row.dailyTokenLimit),
    lifetimeTokenLimit: row.lifetimeTokenLimit == null ? null : Number(row.lifetimeTokenLimit),
    expiresAt: row.expiresAt || null,
    updatedAt: row.updatedAt,
  };
}

export async function getApiKeyPolicy(keyId) {
  const db = await getAdapter();
  return rowToPolicy(db.get(`SELECT * FROM apiKeyAcl WHERE keyId = ?`, [keyId]));
}

export async function setApiKeyPolicy(keyId, input) {
  const policy = normalizeApiKeyPolicy(input);
  const db = await getAdapter();
  db.run(`INSERT INTO apiKeyAcl(keyId, allowedModels, dailyTokenLimit, lifetimeTokenLimit, expiresAt, updatedAt)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(keyId) DO UPDATE SET allowedModels = excluded.allowedModels, dailyTokenLimit = excluded.dailyTokenLimit,
      lifetimeTokenLimit = excluded.lifetimeTokenLimit, expiresAt = excluded.expiresAt, updatedAt = excluded.updatedAt`,
    [keyId, stringifyJson(policy.allowedModels), policy.dailyTokenLimit, policy.lifetimeTokenLimit, policy.expiresAt, new Date().toISOString()]);
  return { ...policy, updatedAt: new Date().toISOString() };
}

export async function deleteApiKeyPolicy(keyId) {
  const db = await getAdapter();
  db.run(`DELETE FROM apiKeyAcl WHERE keyId = ?`, [keyId]);
}
