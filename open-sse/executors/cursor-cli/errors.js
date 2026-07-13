/**
 * Cursor CLI error classification.
 *
 * Pure module — no fetch, no logger, no protobuf dependency. The classifier
 * feeds existing `checkFallbackError()` / `applyErrorState()` in
 * `open-sse/services/accountFallback.js` via sanitized { status, message } pairs.
 */

// ── Error categories ────────────────────────────────────────────────────────

export const CURSOR_CLI_ERROR_CATEGORIES = Object.freeze({
  AUTHENTICATION: "authentication",
  INVALID_MODEL: "invalid_model",
  INVALID_REQUEST: "invalid_request",
  TEMPORARY_ACCOUNT_LIMIT: "temporary_account_limit",
  DEFINITIVE_QUOTA: "definitive_quota",
  MODEL_CAPACITY: "model_capacity",
  UPSTREAM: "upstream",
  PROTOCOL: "protocol",
  UNKNOWN: "unknown",
});

// Connect/gRPC status codes to category
const CONNECT_CODE_TO_CATEGORY = Object.freeze({
  UNAUTHENTICATED: CURSOR_CLI_ERROR_CATEGORIES.AUTHENTICATION,
  PERMISSION_DENIED: CURSOR_CLI_ERROR_CATEGORIES.AUTHENTICATION,
  NOT_FOUND: CURSOR_CLI_ERROR_CATEGORIES.INVALID_MODEL,
  INVALID_ARGUMENT: CURSOR_CLI_ERROR_CATEGORIES.INVALID_REQUEST,
  FAILED_PRECONDITION: CURSOR_CLI_ERROR_CATEGORIES.INVALID_REQUEST,
  RESOURCE_EXHAUSTED: CURSOR_CLI_ERROR_CATEGORIES.MODEL_CAPACITY,
  UNAVAILABLE: CURSOR_CLI_ERROR_CATEGORIES.UPSTREAM,
  DEADLINE_EXCEEDED: CURSOR_CLI_ERROR_CATEGORIES.UPSTREAM,
  INTERNAL: CURSOR_CLI_ERROR_CATEGORIES.UPSTREAM,
  CANCELLED: CURSOR_CLI_ERROR_CATEGORIES.UPSTREAM,
  UNKNOWN: CURSOR_CLI_ERROR_CATEGORIES.UNKNOWN,
});

const CONNECT_CODE_NUMBERS = Object.freeze({
  16: "UNAUTHENTICATED",
  7: "PERMISSION_DENIED",
  5: "NOT_FOUND",
  3: "INVALID_ARGUMENT",
  9: "FAILED_PRECONDITION",
  8: "RESOURCE_EXHAUSTED",
  14: "UNAVAILABLE",
  4: "DEADLINE_EXCEEDED",
  13: "INTERNAL",
  1: "CANCELLED",
  2: "UNKNOWN",
});

// ── Pattern classifiers ────────────────────────────────────────────────────

const ACCOUNT_LIMIT_PATTERNS = [
  /\brate[- ]limit(?:ed)?\b/i,
  /\btoo many requests\b/i,
  /\bmessage rate limit\b/i,
  /\bresets?\s+in\b/i,
];

const DEFINITIVE_QUOTA_PATTERNS = [
  /\bquota\s+(?:exceeded|exhausted|depleted|reached|limit)\b/i,
  /\bcredits?\s+(?:exhausted|depleted|used|ran out)\b/i,
  /\busage[- ]limit\s+(?:exceeded|reached)\b/i,
  /\bno remaining (?:credits?|quota)\b/i,
];

const MODEL_CAPACITY_PATTERNS = [
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /\bresource[- ]exhausted\b/i,
  /\btoo busy\b/i,
  /\bcurrently unavailable\b/i,
  /\bmodel is at capacity\b/i,
];

const AUTH_PATTERNS = [
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bnot authenticated\b/i,
  /\binvalid (?:api[- ]key|token|credential|auth)\b/i,
  /\bexpired token\b/i,
  /\baccess denied\b/i,
];

const INVALID_MODEL_PATTERNS = [
  /\bmodel not found\b/i,
  /\bunknown model\b/i,
  /\bunsupported model\b/i,
];

const PROTOCOL_PATTERNS = [
  /\bunknown[- ]field\b/i,
  /\bconnect[- ](?:encoding|decoding)\b/i,
  /\bproto[- ]decode\b/i,
  /\bunexpected (?:frame|message|eof|end of stream)\b/i,
];

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a Cursor CLI failure from HTTP status, Connect error, or trailer data.
 */
export function classifyCursorCliError({
  status,
  connectCode,
  message = "",
  bodySnippet = "",
  isTrailer = false,
  isEndStream = false,
}) {
  const codeStr =
    connectCode !== undefined
      ? CONNECT_CODE_NUMBERS[Number(connectCode)] ||
        String(connectCode).toUpperCase()
      : undefined;

  // Direct Connect/gRPC code mapping → most specific
  if (codeStr && CONNECT_CODE_TO_CATEGORY[codeStr]) {
    return _result(CONNECT_CODE_TO_CATEGORY[codeStr], message);
  }

  // Status-code-based classification
  const statusNum = Number(status);
  if (statusNum === 401 || statusNum === 403) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.AUTHENTICATION, message);
  }
  if (statusNum === 429) {
    // Check patterns to distinguish quota from capacity
    if (_matchesBody(message, DEFINITIVE_QUOTA_PATTERNS)) {
      return _result(CURSOR_CLI_ERROR_CATEGORIES.DEFINITIVE_QUOTA, message);
    }
    if (_matchesBody(message, ACCOUNT_LIMIT_PATTERNS)) {
      return _result(CURSOR_CLI_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT, message);
    }
    return _result(CURSOR_CLI_ERROR_CATEGORIES.MODEL_CAPACITY, message);
  }
  if (statusNum >= 400 && statusNum < 500) {
    if (_matchesBody(message, INVALID_MODEL_PATTERNS)) {
      return _result(CURSOR_CLI_ERROR_CATEGORIES.INVALID_MODEL, message);
    }
    return _result(CURSOR_CLI_ERROR_CATEGORIES.INVALID_REQUEST, message);
  }
  if (statusNum >= 500 || !statusNum) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.UPSTREAM, message);
  }

  // Pattern-based classification from message/body
  const searchText = `${message}\n${bodySnippet}`;

  if (_matchesBody(searchText, DEFINITIVE_QUOTA_PATTERNS)) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.DEFINITIVE_QUOTA, message);
  }
  if (_matchesBody(searchText, ACCOUNT_LIMIT_PATTERNS)) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT, message);
  }
  if (_matchesBody(searchText, MODEL_CAPACITY_PATTERNS)) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.MODEL_CAPACITY, message);
  }
  if (_matchesBody(searchText, AUTH_PATTERNS)) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.AUTHENTICATION, message);
  }
  if (_matchesBody(searchText, INVALID_MODEL_PATTERNS)) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.INVALID_MODEL, message);
  }
  if (_matchesBody(searchText, PROTOCOL_PATTERNS)) {
    return _result(CURSOR_CLI_ERROR_CATEGORIES.PROTOCOL, message);
  }

  return _result(CURSOR_CLI_ERROR_CATEGORIES.UNKNOWN, message);
}

function _result(category, message) {
  return {
    category,
    message: sanitizeCursorCliErrorMessage(message),
    clientError:
      category === CURSOR_CLI_ERROR_CATEGORIES.INVALID_REQUEST ||
      category === CURSOR_CLI_ERROR_CATEGORIES.INVALID_MODEL,
    retryable:
      category === CURSOR_CLI_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT ||
      category === CURSOR_CLI_ERROR_CATEGORIES.MODEL_CAPACITY ||
      category === CURSOR_CLI_ERROR_CATEGORIES.UPSTREAM ||
      category === CURSOR_CLI_ERROR_CATEGORIES.PROTOCOL ||
      category === CURSOR_CLI_ERROR_CATEGORIES.UNKNOWN ||
      category === CURSOR_CLI_ERROR_CATEGORIES.AUTHENTICATION,
  };
}

function _matchesBody(body, patterns) {
  return patterns.some((p) => p.test(body));
}

// ── Sanitization ────────────────────────────────────────────────────────────

const TOKEN_LIKE_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[\w._-]{20,}/gi,
  /session[-_]?token[=:]\s*[\w._-]{20,}/gi,
];

export function sanitizeCursorCliErrorMessage(message) {
  let sanitized = String(message || "");
  for (const pattern of TOKEN_LIKE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  // Truncate at a reasonable bound
  if (sanitized.length > 2000) {
    sanitized = sanitized.slice(0, 2000) + "…";
  }
  return sanitized;
}

/**
 * Build a fallback error object compatible with 9router's account fallback system.
 */
export function toCursorCliFallbackError({ status, message, connectCode, isTrailer = false, isEndStream = false }) {
  const classification = classifyCursorCliError({
    status,
    connectCode,
    message,
    isTrailer,
    isEndStream,
  });
  return {
    status: classification.clientError ? 400 : Number(status) || 502,
    message: classification.message,
    category: classification.category,
    retryable: classification.retryable,
    clientError: classification.clientError,
  };
}
