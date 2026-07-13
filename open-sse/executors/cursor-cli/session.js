/**
 * Cursor CLI bounded session manager.
 *
 * Retains active HTTP/2 streams only when the Agent API requires inline native
 * tool-result delivery. Always falls back to full context replay when no valid
 * local session is available.
 *
 * Thread-safe within a single Node.js process. Multi-process deployments must
 * handle session affinity externally or degrade gracefully to replay.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {object} CursorCliSession
 * @property {string} conversationId
 * @property {string} connectionKey
 * @property {object} h2Stream — the active HTTP/2 ClientHttp2Stream
 * @property {Map<string, object>} pendingToolCalls — keyed by OpenAI tool-call ID
 * @property {Map<string, Uint8Array>} blobs — request/session-scoped blob store
 * @property {number} lastActivityAt — Date.now()
 * @property {number} createdAt — Date.now()
 */

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_PENDING_CALLS = 20;
const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024; // 10 MiB

export class CursorCliSessionManager {
  #sessions = new Map();
  #maxSessions;
  #idleTtlMs;
  #maxPendingCalls;
  #maxBlobBytes;

  constructor({
    maxSessions = DEFAULT_MAX_SESSIONS,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    maxPendingCalls = DEFAULT_MAX_PENDING_CALLS,
    maxBlobBytes = DEFAULT_MAX_BLOB_BYTES,
  } = {}) {
    this.#maxSessions = maxSessions;
    this.#idleTtlMs = idleTtlMs;
    this.#maxPendingCalls = maxPendingCalls;
    this.#maxBlobBytes = maxBlobBytes;
  }

  /**
   * Open a new Cursor CLI session.
   * Evicts oldest idle session if at capacity.
   */
  open(conversationId, h2Stream, connectionKey) {
    // Evict if at capacity
    if (this.#sessions.size >= this.#maxSessions) {
      const oldest = this.#findOldestIdle();
      if (oldest) {
        this.#closeSession(this.#sessions.get(oldest));
        this.#sessions.delete(oldest);
      }
    }

    const session = {
      conversationId,
      connectionKey,
      h2Stream,
      pendingToolCalls: new Map(),
      blobs: new Map(),
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
    };

    this.#sessions.set(conversationId, session);
    return session;
  }

  /**
   * Acquire a session by conversation ID.
   * Returns undefined if absent, expired, or owned by a different connection.
   */
  acquire(conversationId, connectionKey) {
    const session = this.#sessions.get(conversationId);
    if (!session) return undefined;

    // Expiry check
    if (Date.now() - session.lastActivityAt > this.#idleTtlMs) {
      this.#closeSession(session);
      this.#sessions.delete(conversationId);
      return undefined;
    }

    // Connection ownership check
    if (
      connectionKey !== undefined &&
      session.connectionKey !== connectionKey
    ) {
      return undefined;
    }

    session.lastActivityAt = Date.now();
    return session;
  }

  /**
   * Release a session back to the pool.
   */
  release(session, reason = "idle") {
    if (reason === "idle") {
      this.#closeSession(session);
      this.#sessions.delete(session.conversationId);
    }
    // For "awaiting_tool_result", keep alive for polling
    session.lastActivityAt = Date.now();
  }

  /**
   * Register a pending tool call for a session.
   */
  addPendingCall(session, openAiToolCallId, execMeta) {
    if (session.pendingToolCalls.size >= this.#maxPendingCalls) {
      return false;
    }
    session.pendingToolCalls.set(openAiToolCallId, {
      ...execMeta,
      registeredAt: Date.now(),
    });
    return true;
  }

  /**
   * Store a blob in the session scope.
   */
  storeBlob(session, blobId, data) {
    let totalBytes = 0;
    for (const [, blob] of session.blobs) {
      totalBytes += blob.length;
    }
    if (totalBytes + data.length > this.#maxBlobBytes) {
      return false;
    }
    session.blobs.set(blobId, data);
    return true;
  }

  /**
   * Retrieve a blob by ID.
   */
  getBlob(session, blobId) {
    return session.blobs.get(blobId);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #findOldestIdle() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, session] of this.#sessions) {
      if (session.lastActivityAt < oldestTime) {
        oldestTime = session.lastActivityAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  #closeSession(session) {
    try {
      session.h2Stream?.close?.();
    } catch {}
    session.pendingToolCalls.clear();
    session.blobs.clear();
  }

  size() {
    return this.#sessions.size;
  }

  has(conversationId) {
    return this.#sessions.has(conversationId);
  }

  /**
   * Force evict all sessions — used during shutdown.
   */
  evictAll() {
    for (const [, session] of this.#sessions) {
      this.#closeSession(session);
    }
    this.#sessions.clear();
  }
}

// Singleton for use by the executor (not multi-process safe without affinity)
export const cursorCliSessions = new CursorCliSessionManager();
