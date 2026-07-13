import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPublicUrl: vi.fn(),
  enforceApiKeyPolicy: vi.fn(),
  getCombos: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  handleFetchCore: vi.fn(),
  handleSearchCore: vi.fn(),
  isValidApiKey: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("Authorization")?.replace("Bearer ", "") || null,
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getCombos: mocks.getCombos,
  getSettings: mocks.getSettings,
}));

vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: {
    searcher: { id: "searcher", noAuth: true, searchConfig: {} },
    fetcher: { id: "fetcher", noAuth: true, fetchConfig: {} },
  },
  resolveProviderId: (provider) => provider,
}));

vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: mocks.handleSearchCore,
}));
vi.mock("open-sse/handlers/fetch/index.js", () => ({
  handleFetchCore: mocks.handleFetchCore,
}));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => Response.json({ error: { message } }, { status }),
  unavailableResponse: (status, message) => Response.json({ error: { message } }, { status }),
}));
vi.mock("open-sse/config/runtimeConfig.js", () => ({
  HTTP_STATUS: { BAD_REQUEST: 400, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, UNAUTHORIZED: 401 },
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: (key) => key.slice(0, 3),
  request: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/combo.js", () => ({
  getComboModelsFromData: vi.fn(() => null),
  handleComboChat: vi.fn(),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrl: mocks.assertPublicUrl,
}));
vi.mock("@/sse/services/apiKeyPolicy.js", () => ({
  enforceApiKeyPolicy: mocks.enforceApiKeyPolicy,
}));

const { handleSearch } = await import("../../src/sse/handlers/search.js");
const { handleFetch } = await import("../../src/sse/handlers/fetch.js");

function request(path, body) {
  return new Request(`https://router.test${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer fake-router-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("API key ACL special inference handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCombos.mockResolvedValue([]);
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.enforceApiKeyPolicy.mockResolvedValue({ context: null, error: null });
  });

  it("denies search before provider credential selection or upstream I/O", async () => {
    mocks.enforceApiKeyPolicy.mockResolvedValueOnce({
      context: null,
      error: { status: 403, code: "model_not_allowed", message: "Model is not allowed for this API key" },
    });

    const response = await handleSearch(request("/v1/search", { provider: "searcher", query: "ACL test" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: "Model is not allowed for this API key" } });
    expect(mocks.enforceApiKeyPolicy).toHaveBeenCalledWith({
      apiKey: "fake-router-key",
      body: { provider: "searcher", query: "ACL test" },
      endpoint: "/v1/search",
      model: "searcher",
    });
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleSearchCore).not.toHaveBeenCalled();
  });

  it("denies fetch before provider credential selection or upstream I/O and keeps quota retry headers", async () => {
    mocks.enforceApiKeyPolicy.mockResolvedValueOnce({
      context: null,
      error: { status: 429, code: "token_quota_exceeded", message: "Token quota exceeded", retryAfter: 120 },
    });

    const response = await handleFetch(request("/v1/fetch", { provider: "fetcher", url: "https://example.com" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleFetchCore).not.toHaveBeenCalled();
  });

  it("preserves allowed no-auth search and fetch execution", async () => {
    mocks.handleSearchCore.mockResolvedValueOnce({ success: true, response: Response.json({ results: [] }) });
    mocks.handleFetchCore.mockResolvedValueOnce({ success: true, data: { content: "public" } });

    const [searchResponse, fetchResponse] = await Promise.all([
      handleSearch(request("/v1/search", { provider: "searcher", query: "still works" })),
      handleFetch(request("/v1/fetch", { provider: "fetcher", url: "https://example.com" })),
    ]);

    expect(searchResponse.status).toBe(200);
    expect(fetchResponse.status).toBe(200);
    expect(mocks.handleSearchCore).toHaveBeenCalledOnce();
    expect(mocks.handleFetchCore).toHaveBeenCalledOnce();
  });
});
