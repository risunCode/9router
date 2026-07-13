import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";

const RESERVATION_TTL_MS = 10 * 60 * 1000;
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const total = (row) => Number(row?.committedPromptTokens || 0) + Number(row?.committedCompletionTokens || 0) + Number(row?.reservedTokens || 0);

function nextMidnightSeconds(now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

export async function getApiKeyQuotaSummary(keyId, policy, now = new Date()) {
  const db = await getAdapter();
  const dateKey = localDate(now);
  const [daily, lifetime] = [
    db.get(`SELECT * FROM apiKeyQuotaUsage WHERE keyId = ? AND dateKey = ?`, [keyId, dateKey]),
    db.get(`SELECT * FROM apiKeyLifetimeQuotaUsage WHERE keyId = ?`, [keyId]),
  ];
  const make = (row, limit, resetAt = null) => {
    const used = Number(row?.committedPromptTokens || 0) + Number(row?.committedCompletionTokens || 0);
    const reserved = Number(row?.reservedTokens || 0);
    return { used, reserved, limit: limit ?? null, remaining: limit == null ? null : Math.max(0, limit - used - reserved), resetAt };
  };
  return { daily: make(daily, policy?.dailyTokenLimit ?? null, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()), lifetime: make(lifetime, policy?.lifetimeTokenLimit ?? null) };
}

export async function reserveApiKeyQuota({ keyId, policy, estimatedTokens = 0, endpoint = null, model = null, now = new Date() }) {
  if (!policy || (!policy.dailyTokenLimit && !policy.lifetimeTokenLimit)) return { reservationId: null, estimatedTokens: 0 };
  const amount = Math.max(0, Math.floor(Number(estimatedTokens) || 0));
  const db = await getAdapter();
  const dateKey = localDate(now);
  let result;
  db.transaction(() => {
    const cutoff = new Date(now.getTime() - RESERVATION_TTL_MS).toISOString();
    const stale = db.all(`SELECT * FROM apiKeyQuotaReservations WHERE keyId = ? AND expiresAt <= ?`, [keyId, cutoff]);
    for (const reservation of stale) {
      db.run(`DELETE FROM apiKeyQuotaReservations WHERE id = ?`, [reservation.id]);
      db.run(`UPDATE apiKeyQuotaUsage SET reservedTokens = MAX(0, reservedTokens - ?) WHERE keyId = ? AND dateKey = ?`, [reservation.reservedTokens, keyId, reservation.dateKey]);
      db.run(`UPDATE apiKeyLifetimeQuotaUsage SET reservedTokens = MAX(0, reservedTokens - ?) WHERE keyId = ?`, [reservation.reservedTokens, keyId]);
    }
    const daily = db.get(`SELECT * FROM apiKeyQuotaUsage WHERE keyId = ? AND dateKey = ?`, [keyId, dateKey]);
    const lifetime = db.get(`SELECT * FROM apiKeyLifetimeQuotaUsage WHERE keyId = ?`, [keyId]);
    if (policy.dailyTokenLimit != null && total(daily) + amount > policy.dailyTokenLimit) { result = { error: { status: 429, code: "token_quota_exceeded", message: "Daily token quota exceeded", retryAfter: nextMidnightSeconds(now) } }; return; }
    if (policy.lifetimeTokenLimit != null && total(lifetime) + amount > policy.lifetimeTokenLimit) { result = { error: { status: 429, code: "token_quota_exceeded", message: "Lifetime token quota exceeded" } }; return; }
    const reservationId = randomUUID();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS).toISOString();
    db.run(`INSERT INTO apiKeyQuotaReservations(id, keyId, dateKey, reservedTokens, createdAt, expiresAt, endpoint, model) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, [reservationId, keyId, dateKey, amount, createdAt, expiresAt, endpoint, model]);
    db.run(`INSERT INTO apiKeyQuotaUsage(keyId, dateKey, reservedTokens) VALUES(?, ?, ?) ON CONFLICT(keyId, dateKey) DO UPDATE SET reservedTokens = reservedTokens + excluded.reservedTokens`, [keyId, dateKey, amount]);
    db.run(`INSERT INTO apiKeyLifetimeQuotaUsage(keyId, reservedTokens, updatedAt) VALUES(?, ?, ?) ON CONFLICT(keyId) DO UPDATE SET reservedTokens = reservedTokens + excluded.reservedTokens, updatedAt = excluded.updatedAt`, [keyId, amount, createdAt]);
    result = { reservationId, estimatedTokens: amount };
  });
  return result;
}

export async function settleApiKeyQuota({ reservationId, usage = null }) {
  if (!reservationId) return;
  const db = await getAdapter();
  db.transaction(() => {
    const reservation = db.get(`SELECT * FROM apiKeyQuotaReservations WHERE id = ?`, [reservationId]);
    if (!reservation) return;
    const prompt = Math.max(0, Math.floor(Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0)));
    const completion = Math.max(0, Math.floor(Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0)));
    const actual = prompt + completion || reservation.reservedTokens;
    const settledPrompt = prompt + completion ? prompt : actual;
    const settledCompletion = prompt + completion ? completion : 0;
    db.run(`DELETE FROM apiKeyQuotaReservations WHERE id = ?`, [reservation.id]);
    db.run(`UPDATE apiKeyQuotaUsage SET reservedTokens = MAX(0, reservedTokens - ?), committedPromptTokens = committedPromptTokens + ?, committedCompletionTokens = committedCompletionTokens + ? WHERE keyId = ? AND dateKey = ?`, [reservation.reservedTokens, settledPrompt, settledCompletion, reservation.keyId, reservation.dateKey]);
    db.run(`UPDATE apiKeyLifetimeQuotaUsage SET reservedTokens = MAX(0, reservedTokens - ?), committedPromptTokens = committedPromptTokens + ?, committedCompletionTokens = committedCompletionTokens + ?, updatedAt = ? WHERE keyId = ?`, [reservation.reservedTokens, settledPrompt, settledCompletion, new Date().toISOString(), reservation.keyId]);
  });
}
