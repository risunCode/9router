import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import registry from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { GetChatMessageResponseSchema } from "../../open-sse/executors/devin/proto/exa/api_server_pb/api_server_pb.js";
import { DEVIN_MODEL_ID } from "../../open-sse/executors/devin/request.js";
import { encodeConnectFrame } from "../../open-sse/executors/devin/protocol.js";
import { createDevinSseResponse } from "../../open-sse/executors/devin/response.js";

describe("Devin provider integration", () => {
  it("registers one canonical vision-capable model and specialized executor", () => {
    const provider = registry.find((entry) => entry.id === "devin");
    expect(provider).toBeDefined();
    expect(provider.authModes).toEqual(["apikey"]);
    expect(provider.models).toEqual([expect.objectContaining({ id: DEVIN_MODEL_ID, contextWindow: 200000 })]);
    expect(provider.display.icon).toBe("/providers/devin.png");
    expect(getCapabilitiesForModel("devin", DEVIN_MODEL_ID)).toEqual(expect.objectContaining({ vision: true, tools: true, reasoning: true, contextWindow: 200000 }));
    expect(hasSpecializedExecutor("devin")).toBe(true);
    expect(getExecutor("devin").getProvider()).toBe("devin");
  });

  it("rejects an unsupported model as a client error before transport", async () => {
    const executor = getExecutor("devin");
    await expect(executor.execute({ model: "unsupported", body: { messages: [{ role: "user", content: "hi" }] }, credentials: { apiKey: "fake" } })).rejects.toMatchObject({ clientError: true, retryable: false });
  });

  it("marks a trailer failure after text as valuable output to prohibit replay", async () => {
    const data = encodeConnectFrame(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, { deltaText: "partial" })));
    const trailer = encodeConnectFrame(Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message: "rate limit" } })), { compressed: false, trailer: true });
    const response = createDevinSseResponse(new Response(Buffer.concat([data, trailer])), DEVIN_MODEL_ID);
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    await expect(reader.read()).rejects.toMatchObject({ valuableOutput: true });
  });
});
