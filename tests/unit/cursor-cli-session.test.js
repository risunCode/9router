/**
 * Cursor CLI session manager tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CursorCliSessionManager } from "../../open-sse/executors/cursor-cli/session.js";

describe("CursorCliSessionManager", () => {
  let mgr;

  beforeEach(() => {
    mgr = new CursorCliSessionManager({
      maxSessions: 3,
      idleTtlMs: 50,
      maxPendingCalls: 5,
      maxBlobBytes: 1024,
    });
  });

  it("opens a session", () => {
    const h2 = { close: () => {} };
    const session = mgr.open("conv-1", h2, "conn-a");
    expect(session.conversationId).toBe("conv-1");
    expect(session.connectionKey).toBe("conn-a");
    expect(mgr.size()).toBe(1);
    expect(mgr.has("conv-1")).toBe(true);
  });

  it("acquires a valid session", () => {
    mgr.open("conv-2", { close: () => {} }, "conn-a");
    const session = mgr.acquire("conv-2", "conn-a");
    expect(session).toBeDefined();
    expect(session.conversationId).toBe("conv-2");
  });

  it("returns undefined for expired sessions", async () => {
    mgr.open("conv-exp", { close: () => {} }, "conn-a");
    await new Promise((r) => setTimeout(r, 60));
    expect(mgr.acquire("conv-exp")).toBeUndefined();
    expect(mgr.size()).toBe(0);
  });

  it("returns undefined for unknown conversation", () => {
    expect(mgr.acquire("nonexistent")).toBeUndefined();
  });

  it("rejects cross-connection access", () => {
    mgr.open("conv-3", { close: () => {} }, "conn-a");
    expect(mgr.acquire("conv-3", "conn-b")).toBeUndefined();
  });

  it("allows null connection key check", () => {
    mgr.open("conv-4", { close: () => {} }, "conn-a");
    expect(mgr.acquire("conv-4")).toBeDefined(); // no key check
  });

  it("evicts oldest session at capacity", () => {
    const h2 = { close: () => {} };
    mgr.open("first", h2, "k");
    mgr.open("second", h2, "k");
    mgr.open("third", h2, "k");
    // fourth should evict first
    mgr.open("fourth", h2, "k");
    expect(mgr.has("first")).toBe(false);
    expect(mgr.has("fourth")).toBe(true);
    expect(mgr.size()).toBe(3);
  });

  it("stores and retrieves blobs", () => {
    const session = mgr.open("conv-blob", { close: () => {} }, "k");
    const data = Buffer.from("hello");
    const ok = mgr.storeBlob(session, "blob-1", data);
    expect(ok).toBe(true);
    expect(mgr.getBlob(session, "blob-1")?.toString()).toBe("hello");
  });

  it("rejects blobs when exceeded total limit", () => {
    const session = mgr.open("conv-blob2", { close: () => {} }, "k");
    const large = Buffer.alloc(1025, 65);
    const ok = mgr.storeBlob(session, "big", large);
    expect(ok).toBe(false);
  });

  it("registers and tracks pending tool calls", () => {
    const session = mgr.open("conv-tc", { close: () => {} }, "k");
    const ok = mgr.addPendingCall(session, "call_abc", {
      execMsgId: 1,
      execId: "exec-1",
    });
    expect(ok).toBe(true);
    expect(session.pendingToolCalls.has("call_abc")).toBe(true);
  });

  it("rejects pending calls beyond capacity", () => {
    const mgrSmall = new CursorCliSessionManager({
      maxSessions: 2,
      maxPendingCalls: 2,
    });
    const session = mgrSmall.open("conv-caps", { close: () => {} }, "k");
    expect(mgrSmall.addPendingCall(session, "c1", {})).toBe(true);
    expect(mgrSmall.addPendingCall(session, "c2", {})).toBe(true);
    expect(mgrSmall.addPendingCall(session, "c3", {})).toBe(false);
  });

  it("evicts all sessions", () => {
    const h2 = { close: () => {} };
    mgr.open("a", h2, "k");
    mgr.open("b", h2, "k");
    mgr.evictAll();
    expect(mgr.size()).toBe(0);
  });
});
