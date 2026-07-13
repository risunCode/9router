import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GetUserJwtRequestSchema, GetUserJwtResponseSchema } from "./proto/exa/auth_pb/auth_pb.js";
import { MetadataSchema } from "./proto/exa/codeium_common_pb/codeium_common_pb.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { sanitizeDevinErrorMessage, toDevinFallbackError } from "./errors.js";

export const DEVIN_API_URL = "https://server.codeium.com";
export const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_IDE_VERSION = "3.2.23";
export const DEVIN_EXTENSION_VERSION = "1.48.2";
export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export function normalizeDevinSessionToken(value) {
  const token = String(value ?? "").trim().replace(/^(?:devin-session-token\$)+/, "");
  if (!token) throw new Error("Devin session token is required");
  return `${DEVIN_SESSION_TOKEN_PREFIX}${token}`;
}

export function createMetadata(apiKey, userJwt = "") {
  return create(MetadataSchema, {
    apiKey,
    userJwt,
    ideName: "windsurf",
    ideVersion: DEVIN_IDE_VERSION,
    extensionName: "windsurf",
    extensionVersion: DEVIN_EXTENSION_VERSION,
    locale: "en",
  });
}

function decodeAuthPayload(payload) {
  try {
    return fromBinary(GetUserJwtResponseSchema, payload);
  } catch {
    return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
  }
}

function validateApiBaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Devin returned an unsafe API server URL");
  return url.toString().replace(/\/+$/, "");
}

export async function fetchDevinAuthMetadata({ token, baseUrl = DEVIN_API_URL, signal, proxyOptions, fetchImpl = proxyAwareFetch }) {
  const apiKey = normalizeDevinSessionToken(token);
  const request = create(GetUserJwtRequestSchema, { metadata: createMetadata(apiKey) });
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${DEVIN_AUTH_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/proto", "connect-protocol-version": "1", accept: "*/*" },
    body: toBinary(GetUserJwtRequestSchema, request),
    signal,
  }, proxyOptions);
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const message = sanitizeDevinErrorMessage(new TextDecoder().decode(payload));
    const failure = toDevinFallbackError({ status: response.status, message });
    const error = new Error(failure.message || `Devin authentication failed (${response.status})`);
    Object.assign(error, failure);
    throw error;
  }
  if (payload.length > MAX_CONNECT_FRAME_PAYLOAD) throw new Error("Devin auth payload exceeds the safe limit");
  const decoded = decodeAuthPayload(payload);
  if (!decoded.userJwt) throw new Error("Devin authentication returned an empty user JWT");
  return { apiKey, userJwt: decoded.userJwt, baseUrl: validateApiBaseUrl(decoded.customApiServerUrl) ?? baseUrl.replace(/\/+$/, "") };
}

export function encodeConnectFrame(payload, { compressed = true, trailer = false } = {}) {
  const raw = Buffer.from(payload);
  const body = compressed ? gzipSync(raw) : raw;
  if (body.length > MAX_CONNECT_FRAME_PAYLOAD) throw new Error("Devin Connect frame exceeds the safe limit");
  const frame = Buffer.allocUnsafe(5 + body.length);
  frame[0] = (compressed ? CONNECT_COMPRESSED_FLAG : 0) | (trailer ? CONNECT_END_STREAM_FLAG : 0);
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

export class ConnectFrameDecoder {
  #pending = Buffer.alloc(0);

  push(chunk) {
    if (chunk?.length) this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    const frames = [];
    while (this.#pending.length >= 5) {
      const flags = this.#pending[0];
      const length = this.#pending.readUInt32BE(1);
      if (length > MAX_CONNECT_FRAME_PAYLOAD) throw new Error("Devin Connect frame exceeds the safe limit");
      if (this.#pending.length < 5 + length) break;
      const encoded = this.#pending.subarray(5, 5 + length);
      this.#pending = this.#pending.subarray(5 + length);
      frames.push({ flags, trailer: Boolean(flags & CONNECT_END_STREAM_FLAG), payload: flags & CONNECT_COMPRESSED_FLAG ? gunzipSync(encoded) : encoded });
    }
    return frames;
  }

  finish() {
    if (this.#pending.length !== 0) throw new Error("Devin Connect stream ended with a truncated frame");
  }
}
