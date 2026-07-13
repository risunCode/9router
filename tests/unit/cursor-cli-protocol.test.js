/**
 * Cursor CLI protocol smoke tests.
 * Verifies Connect framing, bearer header construction, error classification,
 * and incremental frame decoding without real network I/O.
 */

import { describe, it, expect } from "vitest";
import {
  buildCursorCliHeaders,
  encodeConnectFrame,
  ConnectFrameDecoder,
  parseConnectEndStream,
  parseHttp2Trailers,
  CURSOR_CLI_BASE_URL,
  CURSOR_CLI_AGENT_PATH,
  MAX_CONNECT_FRAME_PAYLOAD,
  CURSOR_CLI_HEARTBEAT_INTERVAL_MS,
} from "../../open-sse/executors/cursor-cli/protocol.js";
import {
  classifyCursorCliError,
  sanitizeCursorCliErrorMessage,
  toCursorCliFallbackError,
  CURSOR_CLI_ERROR_CATEGORIES,
} from "../../open-sse/executors/cursor-cli/errors.js";
import zlib from "zlib";

// ── Header construction ─────────────────────────────────────────────────────

describe("Cursor CLI headers", () => {
  it("builds CLI headers with bearer token", () => {
    const headers = buildCursorCliHeaders({
      accessToken: "test-token-abc",
    });
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe(CURSOR_CLI_AGENT_PATH);
    expect(headers.authorization).toBe("Bearer test-token-abc");
    expect(headers["x-cursor-client-type"]).toBe("cli");
    expect(headers["x-ghost-mode"]).toBe("true");
    expect(headers["content-type"]).toBe("application/connect+proto");
    expect(headers.te).toBe("trailers");
  });

  it("respects ghostMode: false", () => {
    const headers = buildCursorCliHeaders({
      accessToken: "tok",
      ghostMode: false,
    });
    expect(headers["x-ghost-mode"]).toBe("false");
  });
});

// ── Connect frames ──────────────────────────────────────────────────────────

describe("Connect frame encoding", () => {
  it("wraps payload with length prefix", () => {
    const payload = Buffer.from("hello");
    const frame = encodeConnectFrame(payload, { compressed: false, trailer: false });
    // 5-byte header
    expect(frame[0]).toBe(0x00);
    const length = frame.readUInt32BE(1);
    expect(length).toBe(payload.length);
    expect(frame.subarray(5).toString()).toBe("hello");
  });

  it("sets compression flag", () => {
    const payload = Buffer.from("hello world test");
    const frame = encodeConnectFrame(payload, { compressed: true, trailer: false });
    expect(frame[0]).toBe(0x01);
  });

  it("sets end-stream flag", () => {
    const frame = encodeConnectFrame(Buffer.from("x"), {
      compressed: false,
      trailer: true,
    });
    expect(frame[0]).toBe(0x02);
  });

  it("rejects oversized frames", () => {
    const big = Buffer.alloc(MAX_CONNECT_FRAME_PAYLOAD + 1, 65);
    expect(() => encodeConnectFrame(big, { compressed: false, trailer: false })).toThrow(
      /safe limit/
    );
  });
});

// ── Frame decoder ───────────────────────────────────────────────────────────

describe("ConnectFrameDecoder", () => {
  it("decodes a single uncompressed frame", () => {
    const frame = encodeConnectFrame(Buffer.from("test"), {
      compressed: false,
      trailer: false,
    });
    const decoder = new ConnectFrameDecoder();
    const frames = decoder.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString()).toBe("test");
    expect(frames[0].trailer).toBe(false);
  });

  it("decodes a gzipped frame", () => {
    const raw = Buffer.from("compressed-data-test");
    const compressed = zlib.gzipSync(raw);
    const frame = Buffer.alloc(5 + compressed.length);
    frame[0] = 0x01; // compressed
    frame.writeUInt32BE(compressed.length, 1);
    compressed.copy(frame, 5);

    const decoder = new ConnectFrameDecoder();
    const frames = decoder.push(frame);
    expect(frames[0].payload.toString()).toBe("compressed-data-test");
  });

  it("handles split chunks", () => {
    const frame = encodeConnectFrame(Buffer.from("split-test"), {
      compressed: false,
      trailer: false,
    });
    const mid = Math.floor(frame.length / 2);
    const first = frame.subarray(0, mid);
    const second = frame.subarray(mid);

    const decoder = new ConnectFrameDecoder();
    const r1 = decoder.push(first);
    expect(r1).toHaveLength(0); // incomplete

    const r2 = decoder.push(second);
    expect(r2).toHaveLength(1);
    expect(r2[0].payload.toString()).toBe("split-test");
  });

  it("detects truncated frames on finish", () => {
    const frame = encodeConnectFrame(Buffer.from("x".repeat(100)), {
      compressed: false,
      trailer: false,
    });
    const decoder = new ConnectFrameDecoder();
    decoder.push(frame.subarray(0, 3)); // too short
    expect(() => decoder.finish()).toThrow(/truncated/);
  });
});

// ── End-stream / trailer parsing ────────────────────────────────────────────

describe("parseConnectEndStream", () => {
  it("returns null for empty payload", () => {
    expect(parseConnectEndStream(Buffer.from(""))).toBeNull();
  });

  it("parses a structured JSON error", () => {
    const result = parseConnectEndStream(
      Buffer.from(JSON.stringify({ error: { code: "UNAVAILABLE", message: "overloaded" } }))
    );
    expect(result).toMatchObject({
      code: "UNAVAILABLE",
      message: "overloaded",
      isEndStream: true,
    });
  });

  it("handles non-JSON payload", () => {
    const result = parseConnectEndStream(Buffer.from("garbage"));
    expect(result).toMatchObject({
      message: "garbage",
      isProtocol: true,
      isEndStream: true,
    });
  });
});

// ── Error classification ────────────────────────────────────────────────────

describe("Cursor CLI error classification", () => {
  it("classifies 401 as authentication", () => {
    const result = classifyCursorCliError({ status: 401, message: "unauthorized" });
    expect(result.category).toBe(CURSOR_CLI_ERROR_CATEGORIES.AUTHENTICATION);
    expect(result.clientError).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("classifies 403 as authentication", () => {
    const result = classifyCursorCliError({ status: 403, message: "forbidden" });
    expect(result.category).toBe(CURSOR_CLI_ERROR_CATEGORIES.AUTHENTICATION);
  });

  it("classifies 429 with rate-limit pattern as temporary", () => {
    const result = classifyCursorCliError({
      status: 429,
      message: "rate limit exceeded. Resets in: 30s",
    });
    expect(result.category).toBe(CURSOR_CLI_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
  });

  it("classifies 429 with quota pattern as definitive quota", () => {
    const result = classifyCursorCliError({
      status: 429,
      message: "quota exceeded for this billing period",
    });
    expect(result.category).toBe(CURSOR_CLI_ERROR_CATEGORIES.DEFINITIVE_QUOTA);
  });

  it("classifies 400 with model-not-found as invalid model", () => {
    const result = classifyCursorCliError({
      status: 400,
      message: "model not found: unknown-id",
    });
    expect(result.category).toBe(CURSOR_CLI_ERROR_CATEGORIES.INVALID_MODEL);
    expect(result.clientError).toBe(true);
    expect(result.retryable).toBe(false);
  });

  it("classifies 500 as upstream", () => {
    const result = classifyCursorCliError({ status: 500, message: "internal error" });
    expect(result.category).toBe(CURSOR_CLI_ERROR_CATEGORIES.UPSTREAM);
  });

  it("redacts JWTs from error messages", () => {
    const msg = "failed with token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const sanitized = sanitizeCursorCliErrorMessage(msg);
    expect(sanitized).not.toContain("eyJ");
    expect(sanitized).toContain("[redacted]");
  });
});

// ── Fallback error generation ──────────────────────────────────────────────

describe("toCursorCliFallbackError", () => {
  it("builds a fallback error compatible with account selection", () => {
    const err = toCursorCliFallbackError({
      status: 429,
      message: "rate limited",
    });
    expect(err.status).toBe(429);
    expect(err.category).toBe(CURSOR_CLI_ERROR_CATEGORIES.TEMPORARY_ACCOUNT_LIMIT);
    expect(err.retryable).toBe(true);
    expect(err.clientError).toBe(false);
  });

  it("maps client errors to 400 HTTP status", () => {
    const err = toCursorCliFallbackError({
      status: 400,
      message: "invalid model",
    });
    expect(err.status).toBe(400);
    expect(err.clientError).toBe(true);
    expect(err.retryable).toBe(false);
  });
});
