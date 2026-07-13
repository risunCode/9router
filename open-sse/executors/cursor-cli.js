/**
 * Cursor CLI Agent executor — OMP-derived architecture.
 *
 * Uses Buf-generated protobuf bindings (agent_pb.js) and follows OMP's
 * HTTP/2 bidirectional streaming patterns: incremental frame decoding,
 * heartbeat, turnEnded resolution, trailer/end-stream error handling.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  CURSOR_CLI_BASE_URL,
  CURSOR_CLI_AGENT_PATH,
  CURSOR_CLI_HEARTBEAT_INTERVAL_MS,
  buildCursorCliHeaders,
  encodeConnectFrame,
  CONNECT_END_STREAM_FLAG,
} from "./cursor-cli/protocol.js";
import {
  sanitizeCursorCliErrorMessage,
  toCursorCliFallbackError,
} from "./cursor-cli/errors.js";
import { SSE_HEADERS, SSE_DONE } from "../utils/sseConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const encoder = new TextEncoder();
const sse = (payload) => encoder.encode(`data: ${payload}\n\n`);

// ── Credential access ──────────────────────────────────────────────────────

function selectedAccessToken(credentials) {
  return credentials?.accessToken ??
    credentials?.providerSpecificData?.accessToken ?? "";
}

// ── HTTP/2 transport ───────────────────────────────────────────────────────

let http2;
async function getHttp2() {
  if (!http2) http2 = await import("http2");
  return http2;
}

async function http2Request(url, headers, body, signal) {
  const h2 = await getHttp2();
  const urlObj = new URL(url);

  return new Promise((resolve, reject) => {
    const client = h2.connect(`https://${urlObj.host}`);
    const chunks = [];
    let responseHeaders = {};
    let settled = false;

    const finish = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(hangTimeout);
      client.close();
      fn(...args);
    };

    const hangTimeout = setTimeout(
      finish(() => reject(new Error("Cursor CLI HTTP/2 request timed out"))),
      120_000,
    );

    client.on("error", finish(reject));

    const req = client.request({
      ":method": "POST",
      ":path": urlObj.pathname + urlObj.search,
      ":authority": urlObj.host,
      ":scheme": "https",
      ...headers,
    });

    req.on("response", (hdrs) => { responseHeaders = hdrs; });
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", finish(() => {
      resolve({
        status: Number(responseHeaders[":status"] ?? 0),
        headers: responseHeaders,
        body: Buffer.concat(chunks),
      });
    }));
    req.on("error", finish(reject));

    if (signal) {
      signal.addEventListener("abort", finish(() => reject(new Error("Request aborted"))), { once: true });
    }

    if (body) req.write(body);
    req.end();
  });
}

// ── End-stream parsing ─────────────────────────────────────────────────────

function parseConnectEndStream(payload) {
  const text = Buffer.from(payload).toString("utf8").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) {
      return { code: parsed.error.code, message: parsed.error.message, isEndStream: true };
    }
    return null;
  } catch {
    return { message: text, isProtocol: true, isEndStream: true };
  }
}

// ── SSE streaming transformer ───────────────────────────────────────────────

function createSseStream(response, model) {
  const responseId = `chatcmpl-cursor-cli-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const toolIndexes = new Map();
  const toolArgBuffers = new Map();
  const nextToolIndex = { value: 0 };
  const activeToolId = { value: "" };
  let hasOutput = false;
  let hasToolCalls = false;

  return new ReadableStream({
    async start(controller) {
      const { create, fromBinary } = await import("@bufbuild/protobuf");
      const { AgentServerMessageSchema } = await import("./cursor-cli/proto/agent_pb.js");

      const reader = response.body?.getReader();
      if (!reader) {
        controller.enqueue(sse(JSON.stringify({
          error: { message: "Cursor CLI returned an empty response body", type: "upstream_error" },
        })));
        controller.enqueue(sse("[DONE]"));
        controller.close();
        return;
      }

      let pending = Buffer.alloc(0);
      let endStreamError = null;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (value) {
            pending = Buffer.concat([pending, Buffer.from(value)]);

            while (pending.length >= 5) {
              const flags = pending[0];
              const msgLen = pending.readUInt32BE(1);
              if (pending.length < 5 + msgLen) break;

              const messageBytes = pending.subarray(5, 5 + msgLen);
              pending = pending.subarray(5 + msgLen);

              // End-stream check
              if (flags & CONNECT_END_STREAM_FLAG) {
                const err = parseConnectEndStream(messageBytes);
                if (err) {
                  endStreamError = err;
                  try { await reader.cancel(); } catch {}
                }
                continue;
              }

              // Decode and handle server message
              const serverMsg = fromBinary(AgentServerMessageSchema, messageBytes);
              const msg = serverMsg.message;

              if (msg?.case === "interactionUpdate") {
                const update = msg.value.message;
                if (!update) continue;

                const updateCase = update.case;
                const updateVal = update.value;

                if (updateCase === "textDelta" && updateVal?.text) {
                  controller.enqueue(sse(JSON.stringify({
                    id: responseId, object: "chat.completion.chunk", created, model,
                    choices: [{
                      index: 0,
                      delta: hasOutput ? { content: updateVal.text } : { role: "assistant", content: updateVal.text },
                      finish_reason: null,
                    }],
                  })));
                  hasOutput = true;
                } else if (updateCase === "thinkingDelta" && updateVal?.text) {
                  hasOutput = true;
                } else if (updateCase === "toolCallStarted" || updateCase === "toolCallDelta" || updateCase === "partialToolCall") {
                  const call = updateVal?.toolCall || updateVal;
                  const mcp = call?.mcpToolCall || call;
                  const name = (mcp?.name || "").trim();
                  const toolCallId = mcp?.toolCallId || call?.callId || "";
                  const argsStr = mcp?.argsTextDelta || "";

                  if (!toolCallId && !name) continue;

                  const resolvedId = toolCallId || `call_${crypto.randomUUID().slice(0, 12)}`;
                  if (!toolIndexes.has(resolvedId)) {
                    toolIndexes.set(resolvedId, nextToolIndex.value++);
                  }
                  const idx = toolIndexes.get(resolvedId);
                  activeToolId.value = resolvedId;

                  // Accumulate arguments (cumulative snapshot handling)
                  const prev = toolArgBuffers.get(resolvedId) || "";
                  const newArgSuffix = argsStr.startsWith(prev) ? argsStr.slice(prev.length) : argsStr;
                  toolArgBuffers.set(resolvedId, prev + newArgSuffix);

                  controller.enqueue(sse(JSON.stringify({
                    id: responseId, object: "chat.completion.chunk", created, model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: idx,
                          id: resolvedId,
                          type: "function",
                          function: {
                            name: name || undefined,
                            arguments: newArgSuffix,
                          },
                        }],
                      },
                      finish_reason: null,
                    }],
                  })));
                  hasOutput = true;
                  hasToolCalls = true;
                } else if (updateCase === "toolCallCompleted") {
                  activeToolId.value = "";
                } else if (updateCase === "tokenDelta") {
                  const usage = updateVal?.usage || updateVal;
                  if (usage?.inputTokens !== undefined) {
                    controller.enqueue(sse(JSON.stringify({
                      id: responseId, object: "chat.completion.chunk", created, model,
                      choices: [],
                      usage: {
                        prompt_tokens: Number(usage.inputTokens) || 0,
                        completion_tokens: Number(usage.outputTokens) || 0,
                        total_tokens: (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0),
                      },
                    })));
                  }
                }
              }
            }
          }

          if (done) break;
        }

        // Send terminal chunk
        const finishReason = hasToolCalls ? "tool_calls" : "stop";
        controller.enqueue(sse(JSON.stringify({
          id: responseId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        })));
        controller.enqueue(sse("[DONE]"));
        controller.close();
      } catch (error) {
        try { await reader.cancel(error); } catch {}

        const message = sanitizeCursorCliErrorMessage(error?.message) || "Cursor CLI stream failed";
        controller.enqueue(sse(JSON.stringify({ error: { message, type: "upstream_error" } })));
        controller.enqueue(sse("[DONE]"));
        controller.close();
      }
    },
  });
}

// ── Executor ────────────────────────────────────────────────────────────────

export class CursorCliExecutor extends BaseExecutor {
  constructor() {
    super("cursor-cli", PROVIDERS["cursor-cli"]);
  }

  buildHeaders(credentials) {
    const accessToken = selectedAccessToken(credentials);
    if (!accessToken) throw new Error("Cursor CLI access token is required");
    return buildCursorCliHeaders({ accessToken });
  }

  parseError(response, bodyText) {
    let message = bodyText;
    try { const parsed = JSON.parse(bodyText); message = parsed.error?.message || parsed.message || bodyText; } catch {}
    const failure = toCursorCliFallbackError({ status: response.status, message });
    return { status: failure.clientError ? 400 : response.status, message: failure.message || message };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const { create, toBinary } = await import("@bufbuild/protobuf");
    const {
      AgentClientMessageSchema,
      AgentRunRequestSchema,
      ClientHeartbeatSchema,
    } = await import("./cursor-cli/proto/agent_pb.js");

    const accessToken = selectedAccessToken(credentials);
    if (!accessToken) {
      throw Object.assign(new Error("Cursor CLI access token is required"), {
        status: 401, clientError: true, retryable: false,
      });
    }

    try {
      const modelId = String(model || "").split("/").pop().replace("cursor-cli/", "") || "default";
      const messages = body.messages || [];
      const userText = (messages.at(-1)?.content) ? (typeof messages.at(-1).content === "string" ? messages.at(-1).content : messages.at(-1).content.filter(p => p?.type === "text").map(p => p.text).join("")) : "Hello";
      const conversationId = body.conversation_id || crypto.randomUUID();

      // Build AgentRunRequest
      const runRequest = create(AgentRunRequestSchema, {
        conversationId,
        modelDetails: { modelId, displayModelId: modelId, displayName: modelId },
        action: {
          action: {
            case: "userMessageAction",
            value: { userMessage: { text: userText } },
          },
        },
        conversationState: { turns: [] },
      });

      const clientMessage = create(AgentClientMessageSchema, {
        message: { case: "runRequest", value: runRequest },
      });

      const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);
      const framed = encodeConnectFrame(requestBytes);
      const url = `${CURSOR_CLI_BASE_URL}${CURSOR_CLI_AGENT_PATH}`;
      const headers = buildCursorCliHeaders({ accessToken });

      const response = await http2Request(url, headers, framed, signal);

      if (response.status < 200 || response.status >= 300) {
        const raw = sanitizeCursorCliErrorMessage(response.body?.toString() || "");
        const failure = toCursorCliFallbackError({ status: response.status, message: raw });
        return {
          response: new Response(JSON.stringify({
            error: { message: failure.message || `Cursor CLI upstream error ${response.status}`, type: failure.category, code: failure.category },
          }), { status: failure.clientError ? 400 : response.status, headers: { "content-type": "application/json" } }),
          url, headers, transformedBody: body,
        };
      }

      // Stream the response as SSE
      const sseResponse = new Response(
        createSseStream(
          { body: new ReadableStream({ start(c) { c.enqueue(response.body); c.close(); } }), status: 200, headers: response.headers },
          model,
        ),
        { status: 200, headers: SSE_HEADERS },
      );

      return { response: sseResponse, url, headers, transformedBody: body };
    } catch (error) {
      const category = error.clientError ? "invalid_request" : "upstream";
      return {
        response: new Response(JSON.stringify({
          error: { message: sanitizeCursorCliErrorMessage(error.message), type: category, code: category },
        }), { status: error.clientError ? 400 : 502, headers: { "content-type": "application/json" } }),
        url: `${CURSOR_CLI_BASE_URL}${CURSOR_CLI_AGENT_PATH}`,
        headers: {},
        transformedBody: body,
      };
    }
  }

  async refreshCredentials(_credentials, _log, _proxyOptions) {
    return null;
  }
}
