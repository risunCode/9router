import { describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GetChatMessageResponseSchema } from "../../open-sse/executors/devin/proto/exa/api_server_pb/api_server_pb.js";
import { GetUserJwtResponseSchema } from "../../open-sse/executors/devin/proto/exa/auth_pb/auth_pb.js";
import { ChatMessageSource } from "../../open-sse/executors/devin/proto/exa/codeium_common_pb/codeium_common_pb.js";
import { ConnectFrameDecoder, encodeConnectFrame, fetchDevinAuthMetadata, normalizeDevinSessionToken } from "../../open-sse/executors/devin/protocol.js";
import { buildDevinRequest, DEVIN_MODEL_ID } from "../../open-sse/executors/devin/request.js";
import { createDevinSseResponse } from "../../open-sse/executors/devin/response.js";

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
});
