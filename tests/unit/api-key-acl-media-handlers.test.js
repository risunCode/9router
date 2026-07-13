import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enforceApiKeyPolicy: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleEmbeddingsCore: vi.fn(),
  handleImageGenerationCore: vi.fn(),
  handleTtsCore: vi.fn(),
  handleSttCore: vi.fn(),
  clearAccountError: vi.fn(),
  markAccountUnavailable: vi.fn(),
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
  getProviderCredentials: mocks.getProviderCredentials,
  clearAccountError: mocks.clearAccountError,
  markAccountUnavailable: mocks.markAccountUnavailable,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("@/sse/services/apiKeyPolicy.js", () => ({ enforceApiKeyPolicy: mocks.enforceApiKeyPolicy }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    test: { serviceKinds: ["tts", "stt"], noAuth: true, ttsConfig: { authType: "none" }, sttConfig: { authType: "none" } },
  },
}));
vi.mock("open-sse/handlers/embeddingsCore.js", () => ({ handleEmbeddingsCore: mocks.handleEmbeddingsCore }));
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.handleImageGenerationCore }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.handleTtsCore }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.handleSttCore }));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(),
}));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");

const API_KEY = "fake-acl-key";
const POLICY_CONTEXT = { keyId: "key-1", reservationId: null };

function jsonRequest(path, body, key = API_KEY) {
  return new Request(`https://router.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

function sttRequest(model = "test/model", key = API_KEY) {
  const form = new FormData();
  form.set("model", model);
  form.set("file", new Blob(["audio"], { type: "audio/wav" }), "sample.wav");
  return new Request("https://router.example/v1/audio/transcriptions", {
    method: "POST",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
  });
}

const handlers = [
  {
    name: "embeddings",
    endpoint: "/v1/embeddings",
    core: () => mocks.handleEmbeddingsCore,
    request: (key) => jsonRequest("/v1/embeddings", { model: "test/model", input: "hello" }, key),
    run: (request) => handleEmbeddings(request),
  },
  {
    name: "image generation",
    endpoint: "/v1/images/generations",
    core: () => mocks.handleImageGenerationCore,
    request: (key) => jsonRequest("/v1/images/generations", { model: "test/model", prompt: "hello" }, key),
    run: (request) => handleImageGeneration(request),
  },
  {
    name: "text-to-speech",
    endpoint: "/v1/audio/speech",
    core: () => mocks.handleTtsCore,
    request: (key) => jsonRequest("/v1/audio/speech", { model: "test/model", input: "hello" }, key),
    run: (request) => handleTts(request),
  },
  {
    name: "speech-to-text",
    endpoint: "/v1/audio/transcriptions",
    core: () => mocks.handleSttCore,
    request: (key) => sttRequest("test/model", key),
    run: (request) => handleStt(request),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extractApiKey.mockReturnValue(API_KEY);
  mocks.isValidApiKey.mockResolvedValue(true);
  mocks.getSettings.mockResolvedValue({ requireApiKey: true });
  mocks.getModelInfo.mockResolvedValue({ provider: "test", model: "model" });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "connection-1", connectionName: "Test account" });
  mocks.enforceApiKeyPolicy.mockResolvedValue({ context: POLICY_CONTEXT, error: null });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.handleEmbeddingsCore.mockResolvedValue({ success: true, response: new Response("{}") });
  mocks.handleImageGenerationCore.mockResolvedValue({ success: true, response: new Response("{}") });
  mocks.handleTtsCore.mockResolvedValue({ success: true, response: new Response("{}") });
  mocks.handleSttCore.mockResolvedValue({ success: true, response: new Response("{}") });
});

describe("API key ACL media handler enforcement", () => {
  it.each(handlers)("rejects a denied model before $name routing", async ({ endpoint, core, request, run }) => {
    mocks.enforceApiKeyPolicy.mockResolvedValue({
      context: null,
      error: { status: 403, code: "model_not_allowed", message: "Model is not allowed for this API key" },
    });

    const response = await run(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        message: "Model is not allowed for this API key",
        type: "permission_error",
        code: "insufficient_quota",
      },
    });
    expect(mocks.enforceApiKeyPolicy).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: API_KEY,
      model: "test/model",
      endpoint,
    }));
    expect(core()).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(handlers)("returns the existing expiry error shape without routing $name", async ({ core, request, run }) => {
    mocks.enforceApiKeyPolicy.mockResolvedValue({
      context: null,
      error: { status: 401, code: "invalid_api_key", message: "Invalid, disabled, or expired API key" },
    });

    const response = await run(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid, disabled, or expired API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
    expect(core()).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(handlers)("returns quota Retry-After without routing $name", async ({ core, request, run }) => {
    mocks.enforceApiKeyPolicy.mockResolvedValue({
      context: null,
      error: { status: 429, code: "token_quota_exceeded", message: "Token quota exceeded", retryAfter: 3600 },
    });

    const response = await run(request());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        message: "Token quota exceeded",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(core()).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it.each(handlers)("preserves keyless configuration behavior for $name", async ({ core, request, run }) => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.extractApiKey.mockReturnValue(null);
    mocks.enforceApiKeyPolicy.mockResolvedValue({ context: null, error: null });

    const response = await run(request(null));

    expect(response.status).toBe(200);
    expect(mocks.enforceApiKeyPolicy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: null }));
    expect(core()).toHaveBeenCalledOnce();
  });
});
