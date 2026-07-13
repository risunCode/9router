import { describe, expect, it } from "vitest";
import {
  DEVIN_ERROR_CATEGORIES,
  DEVIN_FALLBACK_ELIGIBLE,
  DEVIN_CLIENT_ERROR,
  classifyDevinError,
  sanitizeDevinErrorMessage,
  toDevinFallbackError,
  isDevinQuotaExhaustion,
  isDevinTemporaryLimit,
  isDevinInvalidModel,
} from "../../open-sse/executors/devin/errors.js";

// Fake credentials used to verify sanitization. NEVER a real token.
const FAKE_RAW_TOKEN = "eyJhY2NvdW50IjoidGVzdCJ9.payload.signature_value";
const FAKE_PREFIXED_TOKEN = `devin-session-token$${FAKE_RAW_TOKEN}`;
const FAKE_USER_JWT = "eyJzdWIiOiJmYWtlIn0.fake.payload";
const FAKE_EMAIL = "leak-check@example.com";

// ---------------------------------------------------------------------------
// classifyDevinError — happy paths
// ---------------------------------------------------------------------------

describe("classifyDevinError — temporary per-account limit", () => {
  it("flags explicit 'rate limit' wording as TEMPORARY_ACCOUNT_LIMIT", () => {
    const cat = classifyDevinError({
      status: 429,
      message: "Rate limit exceeded for this account. Try again in 30s.",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("flags 'too many requests' on a per-message limit", () => {
    const cat = classifyDevinError({
      status: 429,
      message: "Too many requests: per-message limit reached, slow down.",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("flags 'retry-after' hint without quota escalation", () => {
    const cat = classifyDevinError({
      status: 429,
      message: "Slow down (retry-after: 5s).",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("flags Connect trailer with retry-after wording", () => {
    const cat = classifyDevinError({
      connectCode: 8, // RESOURCE_EXHAUSTED
      message: "Per-account retry-after 12s",
      isTrailer: true,
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("does NOT escalate bare 'rate limit' to DEFINITIVE_QUOTA", () => {
    const cat = classifyDevinError({
      status: 429,
      message: "Rate limit exceeded",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
    expect(cat).not.toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });
});

describe("classifyDevinError — definitive quota exhaustion", () => {
  it("flags 'quota exhausted' as DEFINITIVE_QUOTA", () => {
    const cat = classifyDevinError({
      status: 429,
      message: "Your account quota is exhausted for this billing cycle.",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
    expect(isDevinQuotaExhaustion({ status: 429, message: "quota exhausted" })).toBe(true);
  });

  it("flags 'credits exceeded' as DEFINITIVE_QUOTA", () => {
    const cat = classifyDevinError({
      status: 429,
      message: "Free-tier credits exceeded for this month.",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });

  it("flags 'usage limit reached' as DEFINITIVE_QUOTA", () => {
    const cat = classifyDevinError({
      status: 429,
      message: "Usage limit reached on swe-1-6-slow. Please upgrade.",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });

  it("flags 'credits depleted' as DEFINITIVE_QUOTA", () => {
    const cat = classifyDevinError({
      status: 403,
      message: "Account credits depleted",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });

  it("flags JSON body with nested error.message quota wording", () => {
    const body = JSON.stringify({
      error: { code: "QUOTA_EXHAUSTED", message: "credits exhausted" },
    });
    const cat = classifyDevinError({ status: 429, bodySnippet: body });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });
});

describe("classifyDevinError — generic 429 / capacity / overloaded (false-positive guard)", () => {
  it("classifies bare 429 without text as MODEL_CAPACITY", () => {
    const cat = classifyDevinError({ status: 429 });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY);
    expect(cat).not.toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });

  it("classifies 'model at capacity' as MODEL_CAPACITY, not quota", () => {
    const cat = classifyDevinError({
      status: 503,
      message: "Model at capacity. Please retry later.",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY);
    expect(isDevinQuotaExhaustion({ status: 503, message: "model at capacity" })).toBe(false);
  });

  it("classifies 'overloaded' as MODEL_CAPACITY, not quota", () => {
    const cat = classifyDevinError({ status: 503, message: "Upstream is overloaded" });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY);
    expect(isDevinQuotaExhaustion({ status: 503, message: "overloaded" })).toBe(false);
  });

  it("classifies 'resource exhausted' WITHOUT quota keyword as MODEL_CAPACITY", () => {
    // Resource exhausted alone is upstream capacity, not quota.
    const cat = classifyDevinError({
      status: 429,
      message: "Resource exhausted, please retry",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY);
    expect(cat).not.toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });

  it("classifies Connect RESOURCE_EXHAUSTED without quota text as MODEL_CAPACITY", () => {
    const cat = classifyDevinError({
      connectCode: 8,
      message: "model capacity exhausted",
      isTrailer: true,
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY);
  });

  it("rejects 'quota exhausted' false positive when status is auth", () => {
    // 401 always wins over text.
    const cat = classifyDevinError({ status: 401, message: "quota exhausted" });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.AUTHENTICATION);
  });

  it("rejects quota escalation when only keyword is present (no escalation word)", () => {
    // 'credits' alone is not enough — must also say exhausted/exceeded/etc.
    const cat = classifyDevinError({ status: 429, message: "Add credits to continue" });
    expect(cat).not.toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });

  it("rejects quota escalation when only escalation word is present (no quota keyword)", () => {
    const cat = classifyDevinError({ status: 429, message: "Limit exhausted for now" });
    expect(cat).not.toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });
});

describe("classifyDevinError — authentication", () => {
  it("classifies HTTP 401 as AUTHENTICATION", () => {
    expect(classifyDevinError({ status: 401, message: "denied" })).toBe(
      DEVIN_ERROR_CATEGORIES.AUTHENTICATION,
    );
  });

  it("classifies HTTP 403 as AUTHENTICATION", () => {
    expect(classifyDevinError({ status: 403, message: "forbidden" })).toBe(
      DEVIN_ERROR_CATEGORIES.AUTHENTICATION,
    );
  });

  it("classifies Connect UNAUTHENTICATED as AUTHENTICATION", () => {
    expect(
      classifyDevinError({ connectCode: 16, message: "missing jwt", isTrailer: true }),
    ).toBe(DEVIN_ERROR_CATEGORIES.AUTHENTICATION);
  });

  it("classifies Connect PERMISSION_DENIED as AUTHENTICATION", () => {
    expect(
      classifyDevinError({ connectCode: 7, message: "no access", isTrailer: true }),
    ).toBe(DEVIN_ERROR_CATEGORIES.AUTHENTICATION);
  });

  it("classifies 'session expired' trailer as AUTHENTICATION even at 200", () => {
    // The auth text rule fires before any other text rule.
    expect(
      classifyDevinError({ status: 200, message: "session expired, please re-login" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.AUTHENTICATION);
  });

  it("classifies 'invalid token' as AUTHENTICATION", () => {
    expect(
      classifyDevinError({ status: 401, message: "invalid token" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.AUTHENTICATION);
  });
});

describe("classifyDevinError — invalid model", () => {
  it("classifies HTTP 404 with model phrase as INVALID_MODEL", () => {
    expect(
      classifyDevinError({ status: 404, message: "Model not found" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_MODEL);
  });

  it("classifies Connect NOT_FOUND as INVALID_MODEL", () => {
    expect(
      classifyDevinError({ connectCode: 5, message: "no such model", isTrailer: true }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_MODEL);
  });

  it("classifies HTTP 400 + 'unsupported model' as INVALID_MODEL", () => {
    expect(
      classifyDevinError({ status: 400, message: "unsupported model: gpt-x" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_MODEL);
  });

  it("classifies HTTP 400 + 'invalid model' as INVALID_MODEL", () => {
    expect(
      classifyDevinError({ status: 400, message: "invalid model id" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_MODEL);
  });

  it("classifies HTTP 404 without model phrase as INVALID_REQUEST", () => {
    expect(
      classifyDevinError({ status: 404, message: "Resource not found" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_REQUEST);
  });

  it("classifies HTTP 400 with validation text as INVALID_REQUEST", () => {
    expect(
      classifyDevinError({ status: 400, message: "validation failed: messages too long" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_REQUEST);
  });

  it("classifies HTTP 400 with no text as INVALID_REQUEST", () => {
    expect(
      classifyDevinError({ status: 400 }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_REQUEST);
  });

  it("classifies Connect INVALID_ARGUMENT as INVALID_REQUEST", () => {
    expect(
      classifyDevinError({ connectCode: 3, message: "bad arg", isTrailer: true }),
    ).toBe(DEVIN_ERROR_CATEGORIES.INVALID_REQUEST);
  });
});

describe("classifyDevinError — upstream / network / protocol", () => {
  it("classifies HTTP 500 as UPSTREAM", () => {
    expect(classifyDevinError({ status: 500, message: "" })).toBe(
      DEVIN_ERROR_CATEGORIES.UPSTREAM,
    );
  });

  it("classifies HTTP 502/503/504 without text as UPSTREAM", () => {
    expect(classifyDevinError({ status: 502 })).toBe(DEVIN_ERROR_CATEGORIES.UPSTREAM);
    expect(classifyDevinError({ status: 504 })).toBe(DEVIN_ERROR_CATEGORIES.UPSTREAM);
  });

  it("classifies 'service unavailable' as UPSTREAM", () => {
    expect(
      classifyDevinError({ status: 503, message: "service unavailable, retry later" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.UPSTREAM);
  });

  it("classifies ECONNRESET wording as UPSTREAM", () => {
    expect(
      classifyDevinError({ message: "ECONNRESET while reading socket" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.UPSTREAM);
  });

  it("classifies 'internal server error' as UPSTREAM", () => {
    expect(
      classifyDevinError({ status: 500, message: "Internal server error" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.UPSTREAM);
  });

  it("classifies isProtocol=true as PROTOCOL regardless of text", () => {
    expect(
      classifyDevinError({ isProtocol: true, status: 200, message: "frame too large" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.PROTOCOL);
  });

  it("classifies 'frame too large' as PROTOCOL", () => {
    expect(
      classifyDevinError({ message: "frame-too-large: payload > MAX_CONNECT_PAYLOAD" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.PROTOCOL);
  });

  it("classifies 'truncated body' as PROTOCOL", () => {
    expect(
      classifyDevinError({ message: "truncated body while decoding trailer" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.PROTOCOL);
  });
});

describe("classifyDevinError — malformed body / defensive parsing", () => {
  it("returns UNKNOWN when input is null or non-object", () => {
    expect(classifyDevinError(null)).toBe(DEVIN_ERROR_CATEGORIES.UNKNOWN);
    expect(classifyDevinError(undefined)).toBe(DEVIN_ERROR_CATEGORIES.UNKNOWN);
    expect(classifyDevinError("boom")).toBe(DEVIN_ERROR_CATEGORIES.UNKNOWN);
    expect(classifyDevinError(42)).toBe(DEVIN_ERROR_CATEGORIES.UNKNOWN);
  });

  it("never throws on a circular JSON-like body", () => {
    const body = JSON.stringify({ error: { message: "rate limit" } }) + "{not-json";
    expect(() =>
      classifyDevinError({ status: 429, bodySnippet: body }),
    ).not.toThrow();
  });

  it("still extracts a usable message when JSON body is malformed but contains text", () => {
    const cat = classifyDevinError({
      status: 429,
      bodySnippet: "<html>429 Too Many Requests: retry-after 30s</html>",
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("ignores non-numeric connectCode without crashing", () => {
    expect(
      classifyDevinError({ connectCode: "banana", message: "rate limit" }),
    ).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("treats Connect UNKNOWN (2) as UPSTREAM, not DEFINITIVE_QUOTA", () => {
    const cat = classifyDevinError({
      connectCode: 2,
      message: "something went wrong",
      isTrailer: true,
    });
    expect(cat).toBe(DEVIN_ERROR_CATEGORIES.UPSTREAM);
  });

  it("returns UNKNOWN when nothing matches", () => {
    expect(classifyDevinError({ status: 418, message: "I am a teapot" })).toBe(
      DEVIN_ERROR_CATEGORIES.UNKNOWN,
    );
  });
});

// ---------------------------------------------------------------------------
// Convenience predicates / fallback-eligible classification
// ---------------------------------------------------------------------------

describe("fallback eligibility surface", () => {
  it("marks TEMPORARY_ACCOUNT_LIMIT, DEFINITIVE_QUOTA, MODEL_CAPACITY, UPSTREAM, AUTH, UNKNOWN as fallback-eligible", () => {
    const cases = [
      { status: 429, message: "rate limit" },
      { status: 429, message: "credits exhausted" },
      { status: 503, message: "model at capacity" },
      { status: 500, message: "internal server error" },
      { status: 401, message: "denied" },
      { status: 418, message: "weird" },
    ];
    for (const c of cases) {
      const cat = classifyDevinError(c);
      expect(DEVIN_FALLBACK_ELIGIBLE.has(cat), `${cat} should be fallback-eligible`).toBe(true);
    }
  });

  it("does NOT mark INVALID_MODEL / INVALID_REQUEST as fallback-eligible", () => {
    expect(DEVIN_FALLBACK_ELIGIBLE.has(DEVIN_ERROR_CATEGORIES.INVALID_MODEL)).toBe(false);
    expect(DEVIN_FALLBACK_ELIGIBLE.has(DEVIN_ERROR_CATEGORIES.INVALID_REQUEST)).toBe(false);
  });

  it("marks INVALID_MODEL and INVALID_REQUEST as client errors", () => {
    expect(DEVIN_CLIENT_ERROR.has(DEVIN_ERROR_CATEGORIES.INVALID_MODEL)).toBe(true);
    expect(DEVIN_CLIENT_ERROR.has(DEVIN_ERROR_CATEGORIES.INVALID_REQUEST)).toBe(true);
  });

  it("isDevinInvalidModel matches both INVALID_MODEL and INVALID_REQUEST", () => {
    expect(isDevinInvalidModel({ status: 404, message: "model not found" })).toBe(true);
    expect(isDevinInvalidModel({ status: 400, message: "validation failed" })).toBe(true);
    expect(isDevinInvalidModel({ status: 429, message: "rate limit" })).toBe(false);
  });

  it("isDevinTemporaryLimit only matches TEMPORARY_ACCOUNT_LIMIT", () => {
    expect(isDevinTemporaryLimit({ status: 429, message: "rate limit" })).toBe(true);
    expect(isDevinTemporaryLimit({ status: 429, message: "model at capacity" })).toBe(false);
    expect(isDevinTemporaryLimit({ status: 429, message: "quota exhausted" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toDevinFallbackError — shape consumed by accountFallback.js
// ---------------------------------------------------------------------------

describe("toDevinFallbackError — native fallback surface", () => {
  it("returns category, status, sanitized message, retryable, clientError", () => {
    const r = toDevinFallbackError({ status: 429, message: "rate limit exceeded" });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
    expect(r.status).toBe(429);
    expect(typeof r.message).toBe("string");
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.retryable).toBe(true);
    expect(r.clientError).toBe(false);
  });

  it("marks quota exhaustion as retryable so model-lock cooldown still applies", () => {
    const r = toDevinFallbackError({ status: 429, message: "credits exhausted" });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
    expect(r.retryable).toBe(true);
  });

  it("marks invalid-model as clientError and not retryable", () => {
    const r = toDevinFallbackError({ status: 404, message: "model not found" });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.INVALID_MODEL);
    expect(r.clientError).toBe(true);
    expect(r.retryable).toBe(false);
  });

  it("falls back to bodySnippet message when no message field is supplied", () => {
    const r = toDevinFallbackError({
      status: 429,
      bodySnippet: JSON.stringify({ error: { message: "rate limit" } }),
    });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
    expect(r.message).toContain("rate limit");
  });

  it("preserves a stable status of null when none supplied", () => {
    const r = toDevinFallbackError({ message: "rate limit" });
    expect(r.status).toBe(null);
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("never throws even when given a hostile body", () => {
    expect(() => toDevinFallbackError({ bodySnippet: "{broken", status: 500 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sanitizeDevinErrorMessage — credential leak guard
// ---------------------------------------------------------------------------

describe("sanitizeDevinErrorMessage — credential leak guard", () => {
  it("redacts a prefixed Devin session token", () => {
    const out = sanitizeDevinErrorMessage(
      `Upstream error: ${FAKE_PREFIXED_TOKEN} rejected`,
    );
    expect(out).not.toContain(FAKE_RAW_TOKEN);
    expect(out).not.toContain(FAKE_PREFIXED_TOKEN);
    expect(out).toContain("[redacted-token]");
  });

  it("redacts a raw session token (no prefix)", () => {
    const out = sanitizeDevinErrorMessage(`auth failed for token=${FAKE_RAW_TOKEN}`);
    expect(out).not.toContain(FAKE_RAW_TOKEN);
    expect(out).toContain("[redacted-token]");
  });

  it("redacts a JWT-shaped payload", () => {
    const out = sanitizeDevinErrorMessage(`user JWT=${FAKE_USER_JWT} is invalid`);
    expect(out).not.toContain(FAKE_USER_JWT);
    expect(out).toContain("[redacted-jwt]");
  });

  it("redacts a Bearer Authorization header value", () => {
    const out = sanitizeDevinErrorMessage("Authorization: Bearer abc123def456ghi789");
    expect(out).not.toContain("abc123def456ghi789");
    expect(out.toLowerCase()).toContain("[redacted");
  });

  it("redacts a lowercase 'authorization:' header", () => {
    const out = sanitizeDevinErrorMessage("authorization= secretvalue12345");
    expect(out).not.toContain("secretvalue12345");
    expect(out).toMatch(/\[redacted\]/i);
  });

  it("redacts x-api-key header values", () => {
    const out = sanitizeDevinErrorMessage("x-api-key: verysecretapikey123");
    expect(out).not.toContain("verysecretapikey123");
  });

  it("redacts cookie values", () => {
    const out = sanitizeDevinErrorMessage("cookie: session=abcdef0123456789");
    expect(out).not.toContain("abcdef0123456789");
  });

  it("redacts email addresses", () => {
    const out = sanitizeDevinErrorMessage(`Account ${FAKE_EMAIL} rejected`);
    expect(out).not.toContain(FAKE_EMAIL);
    expect(out).toContain("[redacted-email]");
  });

  it("redacts access_token / refresh_token fields", () => {
    const out = sanitizeDevinErrorMessage(`{"access_token":"${FAKE_USER_JWT}","refresh_token":"reftoken12345"}`);
    expect(out).not.toContain(FAKE_USER_JWT);
    expect(out).not.toContain("reftoken12345");
  });

  it("caps long messages with an ellipsis", () => {
    const big = "x".repeat(2000);
    const out = sanitizeDevinErrorMessage(big, { maxLength: 100 });
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for null / undefined input", () => {
    expect(sanitizeDevinErrorMessage(null)).toBe("");
    expect(sanitizeDevinErrorMessage(undefined)).toBe("");
    expect(sanitizeDevinErrorMessage("")).toBe("");
  });

  it("handles non-string input by JSON-stringifying safely", () => {
    const out = sanitizeDevinErrorMessage({ code: 429, msg: "rate limit" });
    expect(out).toContain("rate limit");
    expect(out).not.toContain("[object Object]");
  });

  it("never throws on circular objects", () => {
    const obj = { a: 1 };
    obj.self = obj;
    expect(() => sanitizeDevinErrorMessage(obj)).not.toThrow();
  });

  it("preserves generic 429 wording without injecting tokens", () => {
    const out = sanitizeDevinErrorMessage("429: model at capacity");
    expect(out).toBe("429: model at capacity");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: classifier + sanitizer together
// ---------------------------------------------------------------------------

describe("end-to-end classifier + sanitizer integration", () => {
  it("returns a sanitized rate-limit error suitable for fallback", () => {
    const r = toDevinFallbackError({
      status: 429,
      message: `Rate limit hit for token ${FAKE_PREFIXED_TOKEN}`,
    });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
    expect(r.retryable).toBe(true);
    expect(r.message).not.toContain(FAKE_PREFIXED_TOKEN);
    expect(r.message).not.toContain(FAKE_RAW_TOKEN);
  });

  it("returns a sanitized quota error suitable for model-lock cooldown", () => {
    const r = toDevinFallbackError({
      status: 429,
      message: `credits exhausted for ${FAKE_EMAIL}`,
    });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
    expect(r.message).not.toContain(FAKE_EMAIL);
    expect(r.message.toLowerCase()).toContain("credits");
  });

  it("returns a sanitized auth error without leaking the JWT", () => {
    const r = toDevinFallbackError({
      status: 401,
      message: `JWT ${FAKE_USER_JWT} is invalid`,
    });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.AUTHENTICATION);
    expect(r.message).not.toContain(FAKE_USER_JWT);
  });

  it("returns a sanitized protocol error with a stable category", () => {
    const r = toDevinFallbackError({
      isProtocol: true,
      message: "frame too large: payload exceeds max",
    });
    expect(r.category).toBe(DEVIN_ERROR_CATEGORIES.PROTOCOL);
    expect(r.message.toLowerCase()).toContain("frame too large");
  });
});
