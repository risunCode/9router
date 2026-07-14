import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Shared mock db instance — must be hoisted for vi.mock factories
const { mockDbInstance } = vi.hoisted(() => ({
  mockDbInstance: {
    prepare: vi.fn(),
    close: vi.fn(),
    __throwOnConstruct: false,
  },
}));

// Mock better-sqlite3 so require('better-sqlite3') returns the MockDatabase directly
vi.mock("better-sqlite3", () => {
  const MockDatabase = class {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN");
      }
      return mockDbInstance;
    }
  };
  return MockDatabase;
});

// We need to dynamically import after mocks are registered
let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("returns not-found when no macOS cursor db paths are accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });

  it("falls through to manual fallback when db cannot be opened", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    // When better-sqlite3 fails, handler falls through to CLI fallback
    // and then to the manual fallback prompt
    expect(response.body.found).toBe(false);
  });

  // ── Token extraction ──────────────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const get = vi.fn()
      .mockReturnValueOnce({ value: "test-token" })
      .mockReturnValueOnce({ value: "test-machine-id" });
    mockDbInstance.prepare.mockReturnValue({ get });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    expect(mockDbInstance.close).toHaveBeenCalled();
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    const get = vi.fn()
      .mockReturnValueOnce({ value: '"json-token"' })
      .mockReturnValueOnce({ value: '"json-machine-id"' });
    mockDbInstance.prepare.mockReturnValue({ get });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  // ── Fuzzy fallback (macOS only) ───────────────────────────────────────

  it("falls through to manual fallback when keys are missing", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    // Return null for all key queries
    mockDbInstance.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue(null),
    });

    const response = await GET();

    // No tokens via better-sqlite3 → falls through to CLI (not mocked here)
    // → manual fallback
    expect(response.body.found).toBe(false);
  });

  it("returns manual fallback when tokens are missing after all strategies", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue(null),
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
  });

  // ── Backwards-compatible: linux/win32 keep original single-path logic ─

  it("linux falls back to default paths when db not found", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });

  it("unsupported platform falls back to default Linux paths", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
  });
});
