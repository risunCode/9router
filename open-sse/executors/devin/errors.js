// Devin-specific error classification and sanitization.
//
// Pure module: no fetch, no logger, no protobuf dependency. Safe to import
// from protocol unit tests and from the DevinExecutor. The classifier feeds
// the existing `checkFallbackError()` / `applyErrorState()` /
// `buildModelLockUpdate()` helpers in `open-sse/services/accountFallback.js`
// via sanitized { status, message } pairs, so Devin never introduces a
// second account pool or permanently disables a connection.
//
// Design references:
//   requirements.md 6.2–6.6, 7.1–7.6
//   design.md       "Error model" + "Streaming lifecycle and retry boundary"

export const DEVIN_ERROR_CATEGORIES = Object.freeze({
  TEMPORARY_ACCOUNT_LIMIT: "temporary_account_limit",
  DEFINITIVE_QUOTA: "definitive_quota",
  AUTHENTICATION: "authentication",
  MODEL_CAPACITY: "model_capacity",
  INVALID_MODEL: "invalid_model",
  INVALID_REQUEST: "invalid_request",
  UPSTREAM: "upstream",
  PROTOCOL: "protocol",
  UNKNOWN: "unknown",
});

/** Categories that the executor should expose to account fallback before output. */
export const DEVIN_FALLBACK_ELIGIBLE = new Set([
  DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT,
  DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA,
  DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY,
  DEVIN_ERROR_CATEGORIES.UPSTREAM,
  DEVIN_ERROR_CATEGORIES.AUTHENTICATION,
  DEVIN_ERROR_CATEGORIES.UNKNOWN,
]);

/** Categories that map to a client-visible error without cycling accounts. */
export const DEVIN_CLIENT_ERROR = new Set([
  DEVIN_ERROR_CATEGORIES.INVALID_MODEL,
  DEVIN_ERROR_CATEGORIES.INVALID_REQUEST,
]);

/** Cooldown used when the classifier flags definitive quota exhaustion. */
export const DEVIN_QUOTA_COOLDOWN_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Connect / gRPC status codes we observe from Devin trailers.
// We only map codes we actually receive; everything else stays UNKNOWN.
// ---------------------------------------------------------------------------

const CONNECT_CODES = Object.freeze({
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
});

const CONNECT_CODE_TO_CATEGORY = Object.freeze({
  [CONNECT_CODES.UNAUTHENTICATED]: DEVIN_ERROR_CATEGORIES.AUTHENTICATION,
  [CONNECT_CODES.PERMISSION_DENIED]: DEVIN_ERROR_CATEGORIES.AUTHENTICATION,
  [CONNECT_CODES.NOT_FOUND]: DEVIN_ERROR_CATEGORIES.INVALID_MODEL,
  [CONNECT_CODES.INVALID_ARGUMENT]: DEVIN_ERROR_CATEGORIES.INVALID_REQUEST,
  [CONNECT_CODES.FAILED_PRECONDITION]: DEVIN_ERROR_CATEGORIES.INVALID_REQUEST,
  [CONNECT_CODES.RESOURCE_EXHAUSTED]: DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY,
  [CONNECT_CODES.UNAVAILABLE]: DEVIN_ERROR_CATEGORIES.UPSTREAM,
  [CONNECT_CODES.DEADLINE_EXCEEDED]: DEVIN_ERROR_CATEGORIES.UPSTREAM,
  [CONNECT_CODES.INTERNAL]: DEVIN_ERROR_CATEGORIES.UPSTREAM,
  [CONNECT_CODES.CANCELLED]: DEVIN_ERROR_CATEGORIES.UPSTREAM,
  [CONNECT_CODES.UNKNOWN]: DEVIN_ERROR_CATEGORIES.UNKNOWN,
});

// ---------------------------------------------------------------------------
// Text patterns. Case-insensitive substring matches against the supplied
// message / body snippet. The classifier is intentionally conservative:
// generic 429 / capacity / overloaded / resource-exhausted wording alone
// yields MODEL_CAPACITY — NEVER DEFINITIVE_QUOTA. Only the combination of
// (quota|usage limit|credits) AND (exhausted|exceeded|depleted|reached)
// escalates to DEFINITIVE_QUOTA.
// ---------------------------------------------------------------------------

const TEMPORARY_LIMIT_PATTERNS = [
  /\brate[- ]limit(?:ed)?\b/i,
  /\btoo many requests\b/i,
  /\brequest[- ]rate[- ]exceeded\b/i,
  /\bmessage[- ]limit\b/i,
  /\bmessage rate\b/i,
  /\baccount[- ]limit\b/i,
  /\bper[- ](?:user|account|message|conversation)\b/i,
  /\bretry[- ]after\b/i,
];

const QUOTA_KEYWORDS = [
  "quota",
  "usage limit",
  "usage-limit",
  "credit",
  "credits",
  "credit balance",
];

const QUOTA_ESCALATION_WORDS = [
  "exhausted",
  "exceeded",
  "depleted",
  "reached",
  "used up",
  "ran out",
  "no remaining",
  "no credits",
];

const CAPACITY_PATTERNS = [
  /\bmodel[- ]capacity\b/i,
  /\bat capacity\b/i,
  /\bcapacity[- ]exceeded\b/i,
  /\boverloaded\b/i,
  /\bresource[- ]exhausted\b/i,
  /\btoo busy\b/i,
  /\bhigh[- ]demand\b/i,
  /\btry again later\b/i,
];

const MODEL_ERROR_PATTERNS = [
  /\bunsupported model\b/i,
  /\bmodel[- ]not[- ]found\b/i,
  /\bunknown model\b/i,
  /\bno such model\b/i,
  /\binvalid model\b/i,
];

const VALIDATION_PATTERNS = [
  /\binvalid[- ]argument\b/i,
  /\bvalidation[- ]?(?:error|failed)\b/i,
  /\bbad[- ]request\b/i,
  /\bimproperly[- ]formed\b/i,
];

const AUTH_PATTERNS = [
  /\bauthentication[- ]?failed\b/i,
  /\bunauthenticated\b/i,
  /\binvalid[- ]?credential/i,
  /\binvalid[- ]?token/i,
  /\bexpired[- ]?token/i,
  /\bsession[- ]expired\b/i,
  /\bnot[- ]authorized\b/i,
  /\bforbidden\b/i,
];

const UPSTREAM_PATTERNS = [
  /\binternal[- ]server[- ]error\b/i,
  /\bupstream[- ]error\b/i,
  /\bbad[- ]gateway\b/i,
  /\bgateway[- ]timeout\b/i,
  /\bservice[- ]unavailable\b/i,
  /\bnetwork[- ]?(?:error|failure)\b/i,
  /\beconnreset\b/i,
  /\betimed[- ]?out\b/i,
];

const PROTOCOL_PATTERNS = [
  /\bprotocol[- ]error\b/i,
  /\bframe[- ]too[- ]large\b/i,
  /\boversized[- ]payload\b/i,
  /\btruncated[- ]?(?:frame|payload|body)\b/i,
  /\bunknown[- ]field\b/i,
  /\bconnect[- ](?:encoding|decoding)\b/i,
  /\bproto[- ]decode\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLowerString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.toLowerCase();
  try {
    return String(JSON.stringify(value)).toLowerCase();
  } catch {
    return "";
  }
}

function hasAnyPattern(text, patterns) {
  for (const pat of patterns) {
    if (typeof pat === "string") {
      if (text.includes(pat)) return true;
    } else if (pat.test(text)) {
      return true;
    }
  }
  return false;
}

function hasAnyKeyword(text, keywords) {
  for (const kw of keywords) {
    if (text.includes(kw)) return true;
  }
  return false;
}

function extractJsonString(body) {
  if (!body || typeof body !== "string") return "";
  const trimmed = body.trim();
  if (!trimmed) return "";
  // Try JSON object first.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const candidates = [];
        if (typeof parsed.message === "string") candidates.push(parsed.message);
        if (typeof parsed.error === "string") candidates.push(parsed.error);
        if (parsed.error && typeof parsed.error.message === "string") candidates.push(parsed.error.message);
        if (typeof parsed.msg === "string") candidates.push(parsed.msg);
        if (typeof parsed.reason === "string") candidates.push(parsed.reason);
        if (typeof parsed.code === "string") candidates.push(parsed.code);
        if (Array.isArray(parsed.messages)) candidates.push(parsed.messages.filter(m => typeof m === "string"));
        return candidates.join(" ").toLowerCase();
      }
    } catch {
      /* fall through */
    }
  }
  return trimmed.toLowerCase();
}

function isModelShaped(text) {
  if (!text) return false;
  return MODEL_ERROR_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Public: classifyDevinError
// ---------------------------------------------------------------------------

/**
 * Classify a Devin failure (HTTP response or Connect terminal/trailer frame)
 * into a stable category that the executor maps to native fallback behavior.
 *
 * Input shape (all fields optional):
 *   {
 *     status?:       number             // HTTP status code
 *     connectCode?:  number | string    // Connect/gRPC status code
 *     message?:      string             // upstream-supplied message
 *     bodySnippet?:  string             // raw body excerpt for pattern mining
 *     isTrailer?:    boolean            // true when the failure came from a
 *                                      // Connect trailer; trailer-only path
 *                                      // relies on connectCode + message
 *     isProtocol?:   boolean            // true when the failure is a frame
 *                                      // decode error raised inside Devin
 *   }
 *
 * Returns one of DEVIN_ERROR_CATEGORIES. NEVER throws.
 */
export function classifyDevinError(input) {
  if (!input || typeof input !== "object") return DEVIN_ERROR_CATEGORIES.UNKNOWN;
  try {
    return classifyInternal(input);
  } catch {
    return DEVIN_ERROR_CATEGORIES.UNKNOWN;
  }
}

function classifyInternal(input) {
  const status = Number.isFinite(input.status) ? Number(input.status) : null;
  const connectCodeRaw = input.connectCode;
  const connectCode =
    typeof connectCodeRaw === "number"
      ? connectCodeRaw
      : typeof connectCodeRaw === "string" && /^-?\d+$/.test(connectCodeRaw)
        ? Number(connectCodeRaw)
        : null;

  const rawMessage = typeof input.message === "string" ? input.message : "";
  const bodyText = extractJsonString(input.bodySnippet || "");
  const messageText = rawMessage.toLowerCase();
  const combined = `${messageText} ${bodyText}`.trim();

  // Protocol decode errors raised inside the executor are surfaced directly,
  // independent of upstream wording.
  if (input.isProtocol === true) {
    return DEVIN_ERROR_CATEGORIES.PROTOCOL;
  }

  // 1) Authentication. A 403 carrying explicit quota exhaustion is quota,
  // not a broken credential; classify its text in the quota branch below.
  if (status === 401) return DEVIN_ERROR_CATEGORIES.AUTHENTICATION;
  if (status === 403 && !(combined && hasAnyKeyword(combined, QUOTA_KEYWORDS) && hasAnyKeyword(combined, QUOTA_ESCALATION_WORDS))) return DEVIN_ERROR_CATEGORIES.AUTHENTICATION;
  if (connectCode === CONNECT_CODES.UNAUTHENTICATED) return DEVIN_ERROR_CATEGORIES.AUTHENTICATION;
  if (connectCode === CONNECT_CODES.PERMISSION_DENIED) return DEVIN_ERROR_CATEGORIES.AUTHENTICATION;
  if (combined && hasAnyPattern(combined, AUTH_PATTERNS)) return DEVIN_ERROR_CATEGORIES.AUTHENTICATION;

  // 2) Protocol / frame-level decode failures.
  if (combined && hasAnyPattern(combined, PROTOCOL_PATTERNS)) return DEVIN_ERROR_CATEGORIES.PROTOCOL;

  // 3) Invalid model vs invalid request.
  if (status === 404) {
    return isModelShaped(combined) || connectCode === CONNECT_CODES.NOT_FOUND
      ? DEVIN_ERROR_CATEGORIES.INVALID_MODEL
      : DEVIN_ERROR_CATEGORIES.INVALID_REQUEST;
  }
  if (connectCode === CONNECT_CODES.NOT_FOUND) return DEVIN_ERROR_CATEGORIES.INVALID_MODEL;

  // 400 with explicit model phrasing → invalid model; otherwise validation.
  if (status === 400 || connectCode === CONNECT_CODES.INVALID_ARGUMENT) {
    if (isModelShaped(combined)) return DEVIN_ERROR_CATEGORIES.INVALID_MODEL;
    if (combined && hasAnyPattern(combined, MODEL_ERROR_PATTERNS)) return DEVIN_ERROR_CATEGORIES.INVALID_MODEL;
    if (combined && hasAnyPattern(combined, VALIDATION_PATTERNS)) return DEVIN_ERROR_CATEGORIES.INVALID_REQUEST;
    // No text evidence — still a client error, just generic.
    return DEVIN_ERROR_CATEGORIES.INVALID_REQUEST;
  }
  if (connectCode === CONNECT_CODES.FAILED_PRECONDITION) {
    return isModelShaped(combined)
      ? DEVIN_ERROR_CATEGORIES.INVALID_MODEL
      : DEVIN_ERROR_CATEGORIES.INVALID_REQUEST;
  }

  // 4) Definitive quota — requires BOTH a quota keyword AND an escalation
  //    word in the upstream text. Resource-exhausted wording on its own is
  //    NOT sufficient — that path stays MODEL_CAPACITY.
  if (combined && hasAnyKeyword(combined, QUOTA_KEYWORDS) && hasAnyKeyword(combined, QUOTA_ESCALATION_WORDS)) {
    return DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA;
  }

  // 5) Explicit temporary account/message rate-limit wording wins over the
  // generic "try again later" phrase that often appears in the same message.
  if (combined && hasAnyPattern(combined, TEMPORARY_LIMIT_PATTERNS)) {
    return DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT;
  }

  // 6) Model capacity / overloaded wording (generic 429/5xx without
  // account-specific rate-limit evidence). Connect resource_exhausted falls
  // here unless quota+escalation text promoted it above.
  if (combined && hasAnyPattern(combined, CAPACITY_PATTERNS)) return DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY;

  // 7) Bare 429/500 — generic 429 alone MUST NOT be classified as quota.
  if (status === 429) return DEVIN_ERROR_CATEGORIES.MODEL_CAPACITY;
  if (status === 500 || status === 501 || status === 502 || status === 503 || status === 504) {
    return DEVIN_ERROR_CATEGORIES.UPSTREAM;
  }
  if (status === 408) return DEVIN_ERROR_CATEGORIES.UPSTREAM;

  // 8) Connect codes we couldn't promote above.
  if (connectCode != null) {
    const mapped = CONNECT_CODE_TO_CATEGORY[connectCode];
    if (mapped === DEVIN_ERROR_CATEGORIES.UNKNOWN) return DEVIN_ERROR_CATEGORIES.UPSTREAM;
    if (mapped) return mapped;
  }

  // 9) Generic upstream wording.
  if (combined && hasAnyPattern(combined, UPSTREAM_PATTERNS)) return DEVIN_ERROR_CATEGORIES.UPSTREAM;

  return DEVIN_ERROR_CATEGORIES.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Public: sanitizeDevinErrorMessage
// ---------------------------------------------------------------------------

/**
 * Sanitize upstream error text before returning it to the client or to logs.
 * Strips: Devin session tokens, raw JWTs, Bearer tokens, Authorization
 * headers, cookie-like fragments, and email addresses. Collapses whitespace
 * and caps the final length. NEVER throws.
 *
 * @param {unknown} raw
 * @param {{ maxLength?: number }} [opts]
 * @returns {string}
 */
export function sanitizeDevinErrorMessage(raw, opts = {}) {
  const maxLength = Number.isFinite(opts && opts.maxLength) ? Number(opts.maxLength) : 500;
  let text;
  if (raw == null) text = "";
  else if (typeof raw === "string") text = raw;
  else {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  }
  if (!text) return "";

  let cleaned = text;

  // Devin session tokens (anywhere in the string, prefix-stripped or raw).
  cleaned = cleaned.replace(/devin-session-token\$[A-Za-z0-9._\-+/=]+/gi, "[redacted-token]");
  cleaned = cleaned.replace(/session[_-]?token["'\s:=]+[A-Za-z0-9._\-+/=]{8,}/gi, "session_token=[redacted-token]");

  // Raw session token values supplied as token=... should retain token semantics.
  cleaned = cleaned.replace(/(\btoken\s*=\s*)eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/gi, "$1[redacted-token]");

  // Other raw JWTs (three base64url segments).
  cleaned = cleaned.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]");

  // Bearer / OAuth tokens.
  cleaned = cleaned.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{6,}/gi, "Bearer [redacted]");
  cleaned = cleaned.replace(/access[_-]?token["'\s:=]+[A-Za-z0-9._\-+/=]{6,}/gi, "access_token=[redacted]");
  cleaned = cleaned.replace(/refresh[_-]?token["'\s:=]+[A-Za-z0-9._\-+/=]{6,}/gi, "refresh_token=[redacted]");

  // Authorization headers.
  cleaned = cleaned.replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
  cleaned = cleaned.replace(/(x-api-key\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
  cleaned = cleaned.replace(/(cookie\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
  cleaned = cleaned.replace(/(set-cookie\s*[:=]\s*)([^\n\r;]+)/gi, "$1[redacted]");

  // Email addresses (loose).
  cleaned = cleaned.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]");

  // Collapse whitespace runs.
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (cleaned.length > maxLength) {
    cleaned = `${cleaned.slice(0, maxLength - 1)}…`;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Public: toDevinFallbackError
// ---------------------------------------------------------------------------

/**
 * Build the { category, message, status } tuple the executor passes to the
 * existing native fallback helpers (`checkFallbackError`,
 * `applyErrorState`, `buildModelLockUpdate`). The message is sanitized so
 * existing generic rules match without exposing credentials.
 *
 * @param {Parameters<typeof classifyDevinError>[0]} input
 * @param {{ maxLength?: number }} [opts]
 */
export function toDevinFallbackError(input, opts = {}) {
  const status = Number.isFinite(input && input.status) ? Number(input.status) : null;
  const rawMessage =
    input && typeof input.message === "string"
      ? input.message
      : input && input.bodySnippet
        ? extractJsonString(input.bodySnippet)
        : "";
  const sanitized = sanitizeDevinErrorMessage(rawMessage, opts);
  const category = classifyDevinError(input);
  return {
    category,
    status,
    message: sanitized,
    retryable: DEVIN_FALLBACK_ELIGIBLE.has(category),
    clientError: DEVIN_CLIENT_ERROR.has(category),
  };
}

/**
 * Convenience predicate: returns true when the failure should apply a model
 * lock (longer cooldown) rather than only an account cooldown. Matches the
 * design's "explicit quota exhaustion → longer model cooldown" rule.
 */
export function isDevinQuotaExhaustion(input) {
  return classifyDevinError(input) === DEVIN_ERROR_CATEGORIES.DEFINITIVE_QUOTA;
}

/** Convenience predicate for the temporary per-account rate-limit branch. */
export function isDevinTemporaryLimit(input) {
  return classifyDevinError(input) === DEVIN_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT;
}

/** Convenience predicate: failure must surface as a client error without
 *  cycling through accounts. */
export function isDevinInvalidModel(input) {
  const category = classifyDevinError(input);
  return category === DEVIN_ERROR_CATEGORIES.INVALID_MODEL || category === DEVIN_ERROR_CATEGORIES.INVALID_REQUEST;
}

// Exported for tests. Not part of the public surface.
export const __INTERNAL__ = Object.freeze({
  CONNECT_CODES,
  TEMPORARY_LIMIT_PATTERNS,
  QUOTA_KEYWORDS,
  QUOTA_ESCALATION_WORDS,
  CAPACITY_PATTERNS,
  MODEL_ERROR_PATTERNS,
  VALIDATION_PATTERNS,
  AUTH_PATTERNS,
  UPSTREAM_PATTERNS,
  PROTOCOL_PATTERNS,
});
