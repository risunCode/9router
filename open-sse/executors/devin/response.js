import { fromBinary } from "@bufbuild/protobuf";
import { GetChatMessageResponseSchema } from "./proto/exa/api_server_pb/api_server_pb.js";
import { StopReason } from "./proto/exa/codeium_common_pb/codeium_common_pb.js";
import { ConnectFrameDecoder } from "./protocol.js";
import { sanitizeDevinErrorMessage, toDevinFallbackError } from "./errors.js";

const encoder = new TextEncoder();
const sse = (payload) => encoder.encode(`data: ${payload}\n\n`);

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

export function createDevinSseResponse(response, model) {
  const decoder = new ConnectFrameDecoder();
  const toolIndexes = new Map();
  let nextToolIndex = 0;
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
              delta.tool_calls = message.deltaToolCalls.map((call) => {
                if (!toolIndexes.has(call.id)) toolIndexes.set(call.id, nextToolIndex++);
                valuableOutput = true;
                return { index: toolIndexes.get(call.id), id: call.id, type: "function", function: { name: call.name, arguments: call.argumentsJson } };
              });
            }
            if (Object.keys(delta).length) controller.enqueue(sse(JSON.stringify({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] })));
            if (message.usage) {
              const prompt_tokens = Number(message.usage.inputTokens);
              const completion_tokens = Number(message.usage.outputTokens);
              controller.enqueue(sse(JSON.stringify({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens } })));
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
        controller.error(error);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
