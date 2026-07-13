import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GetChatMessageResponseSchema } from "../../open-sse/executors/devin/proto/exa/api_server_pb/api_server_pb.js";
import { GetUserJwtResponseSchema } from "../../open-sse/executors/devin/proto/exa/auth_pb/auth_pb.js";
import { ChatMessageSource } from "../../open-sse/executors/devin/proto/exa/codeium_common_pb/codeium_common_pb.js";
import { ConnectFrameDecoder, encodeConnectFrame, fetchDevinAuthMetadata, normalizeDevinSessionToken } from "../../open-sse/executors/devin/protocol.js";
import { buildDevinRequest, DEVIN_MODEL_ID } from "../../open-sse/executors/devin/request.js";
import { createDevinSseResponse, probeDevinPreOutput } from "../../open-sse/executors/devin/response.js";

describe("Devin protocol", () => {
  it("normalizes exactly one session prefix", () => {
    expect(normalizeDevinSessionToken(" abc ")).toBe("devin-session-token$abc");
    expect(normalizeDevinSessionToken("devin-session-token$devin-session-token$abc")).toBe("devin-session-token$abc");
    expect(() => normalizeDevinSessionToken(" ")).toThrow(/required/);
  });

  it("decodes split compressed Connect frames", () => {
    const frame = encodeConnectFrame(Buffer.from("hello"));
    const decoder = new ConnectFrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    const frames = decoder.push(frame.subarray(3));
    expect(frames[0].payload.toString()).toBe("hello");
    expect(() => decoder.finish()).not.toThrow();
  });

  it("exchanges a session token for a user JWT", async () => {
    const payload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "fake-user-jwt", customApiServerUrl: "https://custom.example/" }));
    const calls = [];
    const result = await fetchDevinAuthMetadata({ token: "fake", fetchImpl: async (...args) => { calls.push(args); return new Response(payload); } });
    expect(result).toEqual({ apiKey: "devin-session-token$fake", userJwt: "fake-user-jwt", baseUrl: "https://custom.example" });
    expect(calls).toHaveLength(1);
  });
});

describe("Devin request adapter", () => {
  it("maps images, tools, assistant tool calls, and tool results", async () => {
    const { request } = await buildDevinRequest({
      model: DEVIN_MODEL_ID, apiKey: "devin-session-token$fake", userJwt: "fake-user-jwt",
      body: {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
          { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{\"x\":1}" } }] },
          { role: "tool", tool_call_id: "call-1", content: "ok" },
        ],
        tools: [{ type: "function", function: { name: "inspect", description: "Inspect", parameters: { type: "object" } } }],
      },
    });
    expect(request.prompt).toBe("system");
    expect(request.chatMessagePrompts[0].images[0].mimeType).toBe("image/png");
    expect(request.chatMessagePrompts[1].toolCalls[0].id).toBe("call-1");
    expect(request.chatMessagePrompts[2].source).toBe(ChatMessageSource.TOOL);
    expect(request.tools[0].name).toBe("inspect");
  });

  it("accepts image/jpg data URIs and generic image blocks", async () => {
    const { request } = await buildDevinRequest({
      model: DEVIN_MODEL_ID, apiKey: "devin-session-token$fake", userJwt: "fake-user-jwt",
      body: {
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/jpg;base64,/9j/4AAQSkZJRg==" } },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
        }],
      },
    });
    expect(request.chatMessagePrompts[0].images).toHaveLength(2);
    expect(request.chatMessagePrompts[0].images[0].mimeType).toBe("image/jpeg");
    expect(request.chatMessagePrompts[0].images[1].mimeType).toBe("image/png");
  });

  it("classifies unsafe Devin image input as a client error", async () => {
    await expect(buildDevinRequest({
      model: DEVIN_MODEL_ID, apiKey: "devin-session-token$fake", userJwt: "fake-user-jwt",
      body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///etc/passwd" } }] }] },
    })).rejects.toMatchObject({ status: 400, clientError: true });
  });
});

describe("Devin pre-output probe", () => {
  it("turns a pre-output rate-limit trailer into a retryable HTTP failure", async () => {
    const trailer = encodeConnectFrame(Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message: "Reached message rate limit for this model. Please try again later." } })), { compressed: false, trailer: true });
    const result = await probeDevinPreOutput(new Response(trailer));
    expect(result.failure).toMatchObject({ status: 429, category: "temporary_account_limit", retryable: true });
  });

  it("replays a valuable data frame for normal SSE conversion", async () => {
    const data = encodeConnectFrame(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, { deltaText: "fast" })));
    const result = await probeDevinPreOutput(new Response(data));
    expect(result.failure).toBeUndefined();
    expect(await createDevinSseResponse(result.response, DEVIN_MODEL_ID).text()).toContain("fast");
  });
});

describe("Devin response adapter", () => {
  it("emits canonical text, reasoning, tools, usage, and DONE events", async () => {
    const message = create(GetChatMessageResponseSchema, { deltaText: "hi", deltaThinking: "hmm" });
    const upstream = new Response(encodeConnectFrame(toBinary(GetChatMessageResponseSchema, message)));
    const response = createDevinSseResponse(upstream, DEVIN_MODEL_ID);
    const text = await response.text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain('"reasoning_content":"hmm"');
    expect(text).toContain("[DONE]");
  });

  it("keeps argument-only deltas for an already named tool call", async () => {
    const first = create(GetChatMessageResponseSchema, {
      deltaToolCalls: [{ id: "call-1", name: "save_markdown", argumentsJson: "" }],
    });
    const second = create(GetChatMessageResponseSchema, {
      deltaToolCalls: [{ id: "", name: "", argumentsJson: "{\"filename\"" }],
    });
    const upstream = new Response(Buffer.concat([
      encodeConnectFrame(toBinary(GetChatMessageResponseSchema, first)),
      encodeConnectFrame(toBinary(GetChatMessageResponseSchema, second)),
    ]));
    const response = createDevinSseResponse(upstream, DEVIN_MODEL_ID);
    const text = await response.text();
    expect(text).toContain('"name":"save_markdown"');
    expect(text).toContain('"id":"call-1"');
    expect(text).toContain('"arguments":"{\\"filename\\""');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).not.toContain("Invalid Devin tool call");
  });

  it("deduplicates full accumulated argument deltas from Devin", async () => {
    const first = create(GetChatMessageResponseSchema, {
      deltaToolCalls: [{ id: "call-2", name: "save_markdown", argumentsJson: "{\"filename\"" }],
    });
    const second = create(GetChatMessageResponseSchema, {
      deltaToolCalls: [{ id: "", name: "", argumentsJson: "{\"filename\":\"x.md\"}" }],
    });
    const upstream = new Response(Buffer.concat([
      encodeConnectFrame(toBinary(GetChatMessageResponseSchema, first)),
      encodeConnectFrame(toBinary(GetChatMessageResponseSchema, second)),
    ]));
    const response = createDevinSseResponse(upstream, DEVIN_MODEL_ID);
    const text = await response.text();
    expect(text).toContain('"arguments":"{\\"filename\\""');
    expect(text).toContain('"arguments":":\\"x.md\\"}"');
    expect(text).not.toContain('{\\"filename\\"{\\"filename\\"');
    expect(text).not.toContain("Invalid Devin tool call");
  });

  it("does not forward malformed tool calls with an empty function name", async () => {
    const message = create(GetChatMessageResponseSchema, {
      deltaToolCalls: [{ id: "call-empty", name: "", argumentsJson: "{}" }],
    });
    const upstream = new Response(encodeConnectFrame(toBinary(GetChatMessageResponseSchema, message)));
    const response = createDevinSseResponse(upstream, DEVIN_MODEL_ID);
    const text = await response.text();
    expect(text).toContain("Invalid Devin tool call");
    expect(text).toContain("upstream_error");
    expect(text).not.toContain('"function":{"name":""');
    expect(text).toContain("[DONE]");
  });
});
