import { fromBinary } from "@bufbuild/protobuf";
import { GetChatMessageResponseSchema } from "./proto/exa/api_server_pb/api_server_pb.js";
import { StopReason } from "./proto/exa/codeium_common_pb/codeium_common_pb.js";
import { ConnectFrameDecoder } from "./protocol.js";
import { sanitizeDevinErrorMessage, toDevinFallbackError } from "./errors.js";

const encoder = new TextEncoder();
const sse = (payload) => encoder.encode(`data: ${payload}\n\n`);

function toOpenAiToolCall(call, toolIndexes, toolPartialJson, nextToolIndexRef, activeToolCallRef) {
  const name = call.name?.trim?.() ?? "";
  const toolCallId = call.id || activeToolCallRef.value;
  const isKnownToolCall = toolCallId && toolIndexes.has(toolCallId);
  if (!isKnownToolCall && !name) {
    const details = call.invalidJsonErr || call.invalidJsonStr || "missing function name";
    throw new Error(`Invalid Devin tool call: ${sanitizeDevinErrorMessage(details)}`);
  }
  const resolvedId = toolCallId || `call_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!toolIndexes.has(resolvedId)) toolIndexes.set(resolvedId, nextToolIndexRef.value++);
  activeToolCallRef.value = resolvedId;
  const fn = {};
  if (name) fn.name = name;
  if (call.argumentsJson) {
    const previousJson = toolPartialJson.get(resolvedId) ?? "";
    const accumulatedJson = call.argumentsJson.startsWith(previousJson) ? call.argumentsJson : previousJson + call.argumentsJson;
    toolPartialJson.set(resolvedId, accumulatedJson);
    fn.arguments = accumulatedJson.slice(previousJson.length);
  }
  return { index: toolIndexes.get(resolvedId), id: resolvedId, type: "function", function: fn };
}

function trailerFailure(payload) {
  const text = payload.toString("utf8").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed?.error) return null;
    return toDevinFallbackError({ message: parsed.error.message ?? text, connectCode: parsed.error.code, isTrailer: true });
  } catch {
    return toDevinFallbackError({ message: text, isProtocol: true });
  }
}

function statusForFailure(failure) {
  if (failure.clientError) return 400;
  if (failure.category === "authentication") return 401;
  if (failure.category === "temporary_account_limit" || failure.category === "definitive_quota") return 429;
  return 502;
}

function hasValuableOutput(frame) {
  if (frame.trailer) return false;
  const message = fromBinary(GetChatMessageResponseSchema, frame.payload);
  return Boolean(message.deltaText || message.deltaThinking || message.deltaToolCalls?.length);
}

function replayReader(chunks, reader) {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) controller.enqueue(chunk);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * Reads only until the first complete Connect frame. A trailer error received
 * before any delta is converted to an ordinary HTTP response so 9router's
 * combo/account fallback can select another account. Successful bytes are
 * replayed exactly once to the normal streaming decoder.
 */
export async function probeDevinPreOutput(response) {
  const reader = response.body?.getReader();
  if (!reader) return { response };
  const decoder = new ConnectFrameDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      chunks.push(value);
      const frames = decoder.push(value);
      for (const frame of frames) {
        if (frame.trailer) {
          const failure = trailerFailure(frame.payload);
          if (failure) {
            await reader.cancel(failure).catch(() => {});
            return { failure: { ...failure, status: statusForFailure(failure) } };
          }
          continue;
        }
        if (hasValuableOutput(frame)) {
          return { response: new Response(replayReader(chunks, reader), { status: response.status, headers: response.headers }) };
        }
      }
    }
    if (done) return { response: new Response(replayReader(chunks, reader), { status: response.status, headers: response.headers }) };
  }
}

export function createDevinSseResponse(response, model) {
  const decoder = new ConnectFrameDecoder();
  const toolIndexes = new Map();
  const toolPartialJson = new Map();
  const nextToolIndexRef = { value: 0 };
  const activeToolCallRef = { value: "" };
  let latestStopReason = StopReason.UNSPECIFIED;
  let valuableOutput = false;
  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) { controller.error(new Error("Devin returned an empty response body")); return; }
      try {
        while (true) {
          const { done, value } = await reader.read();
          for (const frame of decoder.push(value)) {
            if (frame.trailer) {
              const failure = trailerFailure(frame.payload);
              if (failure) {
                const error = new Error(sanitizeDevinErrorMessage(failure.message));
                Object.assign(error, failure, { valuableOutput });
                throw error;
              }
              continue;
            }
            const message = fromBinary(GetChatMessageResponseSchema, frame.payload);
            const delta = {};
            if (message.deltaText) { delta.content = message.deltaText; valuableOutput = true; }
            if (message.deltaThinking) { delta.reasoning_content = message.deltaThinking; valuableOutput = true; }
            if (message.deltaToolCalls?.length) {
              try {
                delta.tool_calls = message.deltaToolCalls.map((call) => toOpenAiToolCall(call, toolIndexes, toolPartialJson, nextToolIndexRef, activeToolCallRef));
                valuableOutput = true;
              } catch (error) {
                valuableOutput = true;
                throw error;
              }
            }
            if (Object.keys(delta).length) controller.enqueue(sse(JSON.stringify({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] })));
            if (message.usage) {
              const prompt_tokens = Number(message.usage.inputTokens);
              const completion_tokens = Number(message.usage.outputTokens);
              const cached_tokens = Number(message.usage.cacheReadTokens || 0);
              const cache_creation_input_tokens = Number(message.usage.cacheWriteTokens || 0);
              const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
              if (cached_tokens > 0) usage.cached_tokens = cached_tokens;
              if (cache_creation_input_tokens > 0) usage.cache_creation_input_tokens = cache_creation_input_tokens;
              controller.enqueue(sse(JSON.stringify({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", model, choices: [], usage })));
            }
            if (message.stopReason !== StopReason.UNSPECIFIED) latestStopReason = message.stopReason;
          }
          if (done) break;
        }
        decoder.finish();
        const finishReason = latestStopReason === StopReason.MAX_TOKENS ? "length" : toolIndexes.size ? "tool_calls" : "stop";
        controller.enqueue(sse(JSON.stringify({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })));
        controller.enqueue(sse("[DONE]"));
        controller.close();
      } catch (error) {
        try { await reader.cancel(error); } catch {}
        if (valuableOutput) {
          const message = sanitizeDevinErrorMessage(error?.message) || "Devin stream failed";
          controller.enqueue(sse(JSON.stringify({ error: { message, type: "upstream_error" } })));
          controller.enqueue(sse("[DONE]"));
          controller.close();
          return;
        }
        controller.error(error);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
