/**
 * Cursor CLI Agent protocol primitives.
 *
 * Owns: Connect framing, HTTP/2 transport identity, base URL/endpoint constants,
 * heartbeat lifecycle, trailer parsing, frame bounds, and the incremental
 * ConnectFrameDecoder (back-pressure-safe). Pure — no MCP, no exec, no session.
 */

import { gunzipSync, gzipSync } from "node:zlib";

// ── Endpoint constants ────────────────────────────────────────────────────

export const CURSOR_CLI_BASE_URL = "https://api2.cursor.sh";
export const CURSOR_CLI_AGENT_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_CLI_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
export const CURSOR_CLI_CLIENT_VERSION = "cli-2026.01.09-231024f";
export const CURSOR_CLI_CLIENT_TYPE = "cli";

// ── Connect protocol constants ─────────────────────────────────────────────

export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024; // 16 MiB
export const CURSOR_CLI_HEARTBEAT_INTERVAL_MS = 5000;

// ── HTTP/2 request identity ────────────────────────────────────────────────

/**
 * Build Cursor CLI Agent HTTP/2 request headers.
 * OAuth access token is used directly as bearer — no Devin-style JWT exchange.
 */
export function buildCursorCliHeaders({ accessToken, ghostMode = true }) {
  return {
    ":method": "POST",
    ":path": CURSOR_CLI_AGENT_PATH,
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${accessToken}`,
    "x-ghost-mode": ghostMode ? "true" : "false",
    "x-cursor-client-version": CURSOR_CLI_CLIENT_VERSION,
    "x-cursor-client-type": CURSOR_CLI_CLIENT_TYPE,
    "x-request-id": crypto.randomUUID(),
  };
}

// ── Connect framing ────────────────────────────────────────────────────────

/**
 * Encode a single Connect frame. `compressed` gzips the payload and sets bit 0x01.
 * `trailer` sets bit 0x02.
 */
export function encodeConnectFrame(payload, { compressed = true, trailer = false } = {}) {
  const raw = Buffer.from(payload);
  const body = compressed ? gzipSync(raw) : raw;
  if (body.length > MAX_CONNECT_FRAME_PAYLOAD) {
    throw new Error("Cursor CLI Connect frame exceeds the safe limit");
  }
  const frame = Buffer.allocUnsafe(5 + body.length);
  frame[0] =
    (compressed ? CONNECT_COMPRESSED_FLAG : 0) |
    (trailer ? CONNECT_END_STREAM_FLAG : 0);
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

// ── Incremental frame decoder ──────────────────────────────────────────────

/**
 * Incremental Connect frame decoder. Feed chunks; extract complete frames.
 * Back-pressure-safe: does not allocate unbounded payloads.
 */
export class ConnectFrameDecoder {
  #pending = Buffer.alloc(0);

  push(chunk) {
    if (chunk?.length) {
      this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    }
    const frames = [];
    while (this.#pending.length >= 5) {
      const flags = this.#pending[0];
      const length = this.#pending.readUInt32BE(1);
      if (length > MAX_CONNECT_FRAME_PAYLOAD) {
        throw new Error("Cursor CLI Connect frame exceeds the safe limit");
      }
      if (this.#pending.length < 5 + length) break;

      const encoded = this.#pending.subarray(5, 5 + length);
      this.#pending = this.#pending.subarray(5 + length);

      const trailer = Boolean(flags & CONNECT_END_STREAM_FLAG);
      const payload =
        flags & CONNECT_COMPRESSED_FLAG ? gunzipSync(encoded) : encoded;

      frames.push({ flags, trailer, payload });
    }
    return frames;
  }

  finish() {
    if (this.#pending.length !== 0) {
      throw new Error("Cursor CLI Connect stream ended with a truncated frame");
    }
  }
}

// ── Trailer / end-stream parsing ───────────────────────────────────────────

/**
 * Parse a Connect end-stream (trailer) frame. Returns a structured error
 * object or null if the payload is empty or non-error.
 */
export function parseConnectEndStream(payload) {
  const text = Buffer.from(payload).toString("utf8").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) {
      return {
        code: parsed.error.code,
        message: parsed.error.message,
        isEndStream: true,
      };
    }
    return null;
  } catch {
    return { message: text, isProtocol: true, isEndStream: true };
  }
}

/**
 * Parse HTTP/2 trailers for gRPC status.
 */
export function parseHttp2Trailers(trailers) {
  const status = trailers["grpc-status"];
  const message = trailers["grpc-message"];
  if (status && status !== "0") {
    return {
      code: status,
      message: decodeURIComponent(String(message || "")),
      isTrailer: true,
    };
  }
  return null;
}
