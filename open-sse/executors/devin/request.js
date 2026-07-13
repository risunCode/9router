import { create, toBinary } from "@bufbuild/protobuf";
import { ChatMessageRequestType, GetChatMessageRequestSchema } from "./proto/exa/api_server_pb/api_server_pb.js";
import { CacheControlType, ChatMessagePromptSchema, ChatToolChoiceSchema, ChatToolDefinitionSchema, PromptCacheOptionsSchema } from "./proto/exa/chat_pb/chat_pb.js";
import { ChatMessageSource, ChatToolCallSchema, CompletionConfigurationSchema, ConversationalPlannerMode, ImageDataSchema } from "./proto/exa/codeium_common_pb/codeium_common_pb.js";
import { fetchImageAsBase64, parseDataUri } from "../../translator/concerns/image.js";
import { createMetadata, encodeConnectFrame } from "./protocol.js";

export const DEVIN_MODEL_ID = "swe-1-6-slow";
const DEFAULT_STOPS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

async function imagesFromContent(content, signal) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (part?.type !== "image_url") continue;
    const source = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    let parsed = parseDataUri(source);
    if (!parsed && /^https?:\/\//i.test(source ?? "")) {
      const fetched = await fetchImageAsBase64(source, { signal });
      parsed = fetched ? parseDataUri(fetched.url) : null;
    }
    if (!parsed || !/^image\/(?:png|jpeg|gif|webp)$/i.test(parsed.mimeType)) throw new Error("Unsupported or unsafe Devin image input");
    images.push(create(ImageDataSchema, { base64Data: parsed.base64.replace(/\s+/g, ""), mimeType: parsed.mimeType }));
  }
  return images;
}

function toolCallsFromMessage(message) {
  return (message.tool_calls ?? []).map((toolCall) => create(ChatToolCallSchema, {
    id: toolCall.id,
    name: toolCall.function?.name ?? "",
    argumentsJson: toolCall.function?.arguments ?? "{}",
    isCustomToolCall: true,
  }));
}

async function buildPrompts(messages, signal) {
  const prompts = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      prompts.push(create(ChatMessagePromptSchema, {
        messageId: crypto.randomUUID(), source: ChatMessageSource.TOOL,
        prompt: textFromContent(message.content), toolCallId: message.tool_call_id ?? "",
        toolResultIsError: Boolean(message.is_error), images: await imagesFromContent(message.content, signal),
      }));
      continue;
    }
    const source = message.role === "assistant" ? ChatMessageSource.SYSTEM : ChatMessageSource.USER;
    prompts.push(create(ChatMessagePromptSchema, {
      messageId: crypto.randomUUID(), source, prompt: textFromContent(message.content),
      images: await imagesFromContent(message.content, signal),
      thinking: message.reasoning_content ?? "",
      toolCalls: message.role === "assistant" ? toolCallsFromMessage(message) : [],
    }));
  }
  return prompts;
}

function buildTools(tools) {
  return (tools ?? []).filter((tool) => tool?.type === "function" && tool.function?.name).map((tool) => create(ChatToolDefinitionSchema, {
    name: tool.function.name,
    description: tool.function.description ?? "",
    jsonSchemaString: JSON.stringify(tool.function.parameters ?? { type: "object", properties: {} }),
    strict: Boolean(tool.function.strict),
    isCustomTool: true,
  }));
}

export async function buildDevinRequest({ model, body, apiKey, userJwt, signal }) {
  if (model !== DEVIN_MODEL_ID) throw Object.assign(new Error(`Unsupported Devin model: ${model}`), { status: 400, clientError: true, retryable: false });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) throw Object.assign(new Error("Devin requires at least one message"), { status: 400, clientError: true, retryable: false });
  const systemPrompt = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => textFromContent(message.content)).filter(Boolean).join("\n\n");
  const stop = Array.isArray(body.stop) ? body.stop : typeof body.stop === "string" ? [body.stop] : [];
  const request = create(GetChatMessageRequestSchema, {
    metadata: createMetadata(apiKey, userJwt), prompt: systemPrompt,
    chatMessagePrompts: await buildPrompts(messages, signal), chatModelUid: model,
    requestType: ChatMessageRequestType.CASCADE, plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
    disableParallelToolCalls: body.parallel_tool_calls !== true,
    cascadeId: body.conversation_id ?? crypto.randomUUID(), executionId: crypto.randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n, maxTokens: BigInt(body.max_tokens ?? 64000), maxNewlines: 200n,
      temperature: body.temperature ?? 0.4, firstTemperature: body.temperature ?? 0.4,
      topK: 50n, topP: body.top_p ?? 1, stopPatterns: [...DEFAULT_STOPS, ...stop], fimEotProbThreshold: 1,
    }),
    tools: buildTools(body.tools),
  });
  return { request, bytes: toBinary(GetChatMessageRequestSchema, request), frame: encodeConnectFrame(toBinary(GetChatMessageRequestSchema, request)) };
}
