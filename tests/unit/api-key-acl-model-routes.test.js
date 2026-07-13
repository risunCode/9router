import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  filterModelsByApiKeyPolicy: vi.fn((models, policy) => {
    if (!policy?.allowedModels?.length) return models;
    return models.filter((model) => policy.allowedModels.includes(model.id));
  }),
  getSettings: vi.fn(),
  isLocalRequest: vi.fn(),
  resolveApiKeyPolicy: vi.fn(),
}));

vi.mock("open-sse/config/providerModels.js", () => ({
  PROVIDER_MODELS: {
    acme: [{ id: "allowed" }, { id: "blocked" }],
    gemini: [{ id: "good" }, { id: "bad" }],
  },
  PROVIDER_ID_TO_ALIAS: { acme: "acme", gemini: "gemini" },
}));

vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: {
    acme: [{ id: "allowed" }, { id: "blocked" }],
    gemini: [{ id: "good" }, { id: "bad" }],
  },
  PROVIDER_ID_TO_ALIAS: { acme: "acme", gemini: "gemini" },
  getModelKind: (model, fallback = null) => model.kind || model.type || fallback,
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    acme: { serviceKinds: ["llm"] },
    gemini: { serviceKinds: ["llm"] },
  },
  ALIAS_TO_ID: {},
  getProviderAlias: (provider) => provider,
  isAnthropicCompatibleProvider: () => false,
  isOpenAICompatibleProvider: () => false,
}));

vi.mock("@/lib/localDb", () => ({
  getCombos: vi.fn().mockResolvedValue([]),
  getCustomModels: vi.fn().mockResolvedValue([]),
  getModelAliases: vi.fn().mockResolvedValue({}),
  getProviderConnections: vi.fn().mockResolvedValue([]),
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn().mockResolvedValue({}),
}));
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn() }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn() }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn() }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn() }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn() }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));
vi.mock("open-sse/providers/capabilities.js", () => ({ capabilitiesFromServiceKind: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (request) => request.headers.get("Authorization")?.replace("Bearer ", "") || null,
}));
vi.mock("@/sse/services/apiKeyPolicy.js", () => ({
  filterModelsByApiKeyPolicy: mocks.filterModelsByApiKeyPolicy,
  resolveApiKeyPolicy: mocks.resolveApiKeyPolicy,
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));

const modelsRoute = await import("../../src/app/api/v1/models/route.js");
const kindRoute = await import("../../src/app/api/v1/models/[kind]/route.js");
const infoRoute = await import("../../src/app/api/v1/models/info/route.js");
const geminiRoute = await import("../../src/app/api/v1beta/models/route.js");

function request(path, key = null) {
  return new Request(`https://router.example${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
}

describe("API key ACL model discovery routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isLocalRequest.mockReturnValue(false);
    mocks.resolveApiKeyPolicy.mockResolvedValue({
      key: { id: "key-1" },
      policy: { allowedModels: ["acme/allowed", "gemini/good"] },
    });
  });

  it("rejects remote model discovery without an API key when key auth is enabled", async () => {
    const response = await modelsRoute.GET(request("/v1/models"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { message: "Missing API key", type: "authentication_error" },
    });
    expect(mocks.resolveApiKeyPolicy).not.toHaveBeenCalled();
  });

  it("filters the default and capability model catalogs after API key resolution", async () => {
    const [modelsResponse, kindResponse] = await Promise.all([
      modelsRoute.GET(request("/v1/models", "fake-router-key")),
      kindRoute.GET(request("/v1/models/image", "fake-router-key"), {
        params: Promise.resolve({ kind: "image" }),
      }),
    ]);

    expect(modelsResponse.status).toBe(200);
    expect((await modelsResponse.json()).data.map((model) => model.id)).toEqual([
      "acme/allowed", "gemini/good",
    ]);
    expect(kindResponse.status).toBe(200);
    expect((await kindResponse.json()).data).toEqual([]);
    expect(mocks.resolveApiKeyPolicy).toHaveBeenCalledWith("fake-router-key");
    expect(mocks.filterModelsByApiKeyPolicy).toHaveBeenCalled();
  });

  it("keeps unrestricted and trusted-local catalogs unchanged", async () => {
    mocks.resolveApiKeyPolicy.mockResolvedValueOnce({ key: { id: "key-2" }, policy: null });
    mocks.isLocalRequest.mockReturnValueOnce(true);

    const [unrestricted, local] = await Promise.all([
      modelsRoute.GET(request("/v1/models", "unrestricted-fake-key")),
      modelsRoute.GET(request("/v1/models")),
    ]);

    expect((await unrestricted.json()).data.map((model) => model.id)).toEqual([
      "acme/allowed", "acme/blocked", "gemini/good", "gemini/bad",
    ]);
    expect((await local.json()).data.map((model) => model.id)).toEqual([
      "acme/allowed", "acme/blocked", "gemini/good", "gemini/bad",
    ]);
  });

  it("hides metadata for a model excluded by the key policy", async () => {
    const response = await infoRoute.GET(request("/v1/models/info?id=acme/blocked", "fake-router-key"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: "Model not found: acme/blocked", type: "not_found" },
    });
  });

  it("filters Gemini-format model discovery using canonical policy identifiers", async () => {
    const response = await geminiRoute.GET(request("/v1beta/models", "fake-router-key"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models.map((model) => model.name)).toEqual([
      "models/gemini/good",
      "models/good",
    ]);
  });

  it("rejects invalid, disabled, or expired keys from every catalog route", async () => {
    mocks.resolveApiKeyPolicy.mockResolvedValue(null);

    const [models, kind, info, gemini] = await Promise.all([
      modelsRoute.GET(request("/v1/models", "invalid-fake-key")),
      kindRoute.GET(request("/v1/models/image", "invalid-fake-key"), { params: Promise.resolve({ kind: "image" }) }),
      infoRoute.GET(request("/v1/models/info?id=acme/allowed", "invalid-fake-key")),
      geminiRoute.GET(request("/v1beta/models", "invalid-fake-key")),
    ]);

    for (const response of [models, kind, info, gemini]) {
      expect(response.status).toBe(401);
    }
  });
});
