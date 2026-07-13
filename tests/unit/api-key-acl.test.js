import { describe, expect, it } from "vitest";
import { normalizeApiKeyPolicy } from "../../src/lib/db/repos/apiKeyAclRepo.js";
import { filterModelsByApiKeyPolicy } from "../../src/sse/services/apiKeyPolicy.js";

describe("API key ACL pure policy", () => {
  it("keeps empty allowlists unrestricted and filters exact models", () => {
    const models = [{ id: "devin/swe-1-6-slow" }, { id: "openai/gpt-4" }];
    expect(filterModelsByApiKeyPolicy(models, null)).toEqual(models);
    expect(filterModelsByApiKeyPolicy(models, { allowedModels: ["devin/swe-1-6-slow"] })).toEqual([models[0]]);
  });

  it("normalizes unlimited fields and rejects invalid limits", () => {
    expect(normalizeApiKeyPolicy({ allowedModels: [" devin/swe-1-6-slow ", "devin/swe-1-6-slow"], dailyTokenLimit: 0 })).toMatchObject({ allowedModels: ["devin/swe-1-6-slow"], dailyTokenLimit: null });
    expect(() => normalizeApiKeyPolicy({ dailyTokenLimit: -1 })).toThrow(/dailyTokenLimit/);
  });
});
