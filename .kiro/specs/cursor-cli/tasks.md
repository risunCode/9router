# Cursor CLI Provider Implementation Tasks

> Execute in order. Each task is complete only when its stated tests pass. Do not mark hosted acceptance complete until a real deployed Cursor CLI model succeeds.

- [ ] 1. Establish provider boundaries and regression harness
  - Add focused test fixtures/helpers for a mock HTTP/2 Cursor Agent server and generated Connect frames; all credentials must be fake.
  - Add regression tests proving the existing `cursor` / `cu` registry entry, IDE endpoint, checksum headers, and executor selection remain unchanged.
  - Identify and document the registry generator, OAuth provider registration points, connection schema, model route hooks, executor hook, and existing account fallback boundary.
  - Verify: focused existing Cursor IDE tests and new isolation test pass.

- [ ] 2. Add verified Cursor Agent protobuf dependency closure
  - Copy the required `agent.proto` generated Buf binding closure from the verified OMP reference atomically into `open-sse/executors/cursor-cli/proto/`.
  - Ensure generated relative imports are Node-compatible `.js` imports; remove unavailable source-map directives without hand-editing message definitions.
  - Add a source/version manifest describing the verified OMP reference and regeneration/replacement procedure.
  - Add protocol tests that encode/decode representative `AgentClientMessage`, `AgentServerMessage`, run request, heartbeat, interaction update, tool call, and end-stream-related messages.
  - Verify: generated imports load and protobuf fixture round trips pass.

- [ ] 3. Implement bounded Cursor CLI protocol primitives
  - Create `protocol.js` containing Agent base URL/path, supported client version, frame flags, maximum frame payload, heartbeat interval, and safe HTTP/2 teardown helpers.
  - Implement Connect frame encode/decode with incremental buffering, compression handling where verified, strict payload length/flag validation, truncated-frame detection, and structured end-stream JSON parsing.
  - Implement proxy-aware HTTP/2 tunnel support and abort propagation using established 9router proxy conventions.
  - Add tests for split/coalesced frames, oversized/truncated frames, invalid flags, compressed frames, end-stream errors, cancellation, and resource cleanup.
  - Verify: focused protocol tests pass without network I/O.

- [ ] 4. Implement Cursor CLI OAuth PKCE and token refresh
  - Add a `cursor-cli` OAuth provider using Cursor CLI PKCE deep-link parameters, bounded poll/backoff, JWT expiry extraction, and token exchange refresh.
  - Reuse existing OAuth route/UI, credential persistence, and refresh manager; do not create a separate token store.
  - Sanitize all OAuth errors and enforce fake-token-only tests.
  - Add tests for auth URL composition, polling success/404/backoff/timeout, malformed success data, expiry behavior, refresh success/failure, missing refresh token, and redaction.
  - Verify: OAuth test suite passes and dashboard connection metadata accepts the provider.

- [ ] 5. Register Cursor CLI separately
  - Add `open-sse/providers/registry/cursor-cli.js` with distinct ID, alias, display metadata, OAuth mode, static fallback models, Agent endpoint, and force-stream transport.
  - Register the provider in generated registry aggregation using the repository convention.
  - Add model capabilities only for properties verified by static contract; do not advertise vision until live verification.
  - Register/export `CursorCliExecutor` without changing existing `CursorExecutor` mappings.
  - Add registry, alias, capability, executor-selection, and `/v1/models` tests.
  - Verify: provider baseline/alias tests pass and Cursor IDE regression test remains green.

- [ ] 6. Build canonical Agent request translation
  - Create `request.js` that accepts the canonical 9router OpenAI-shaped body and builds `AgentClientMessage.runRequest` using generated schemas.
  - Encode conversation ID, model details, ordered system/developer/user/assistant/tool history, user/resume action, and canonical MCP tool definitions.
  - Normalize assistant tool calls and role-tool results so replay preserves tool IDs and prevents invalid mixed protobuf messages.
  - Implement supported generation-control mapping and explicit rejection or deterministic prompt constraints for unsupported semantics.
  - Add request decoding tests for role ordering, tool-history replay, model normalization, conversation IDs, MCP schemas, reasoning/tool choices, output constraints, and invalid inputs.
  - Verify: request builder fixture tests pass.

- [ ] 7. Implement Cursor CLI HTTP/2 executor lifecycle
  - Add `CursorCliExecutor` orchestration for one selected credential: validate model, refresh if existing policy requires it, construct headers, open HTTP/2 request, send run request, and return canonical streaming response.
  - Start/stop heartbeat correctly, parse HTTP/2 response status and trailers, bind cancellation, and close all request/session resources in every terminal path.
  - Route pre-output failures to normal error responses usable by existing account fallback; never choose or rotate credentials inside the executor.
  - Add deterministic mock-H2 tests for headers, client identity, request framing, heartbeat lifecycle, trailers, abort, proxy selection, and selected-credential-only execution.
  - Verify: lifecycle tests pass.

- [ ] 8. Translate text, reasoning, usage, and finish states
  - Create `response.js` to decode interaction messages into canonical OpenAI SSE text/reasoning deltas, usage, finish reasons, terminal event, and `[DONE]`.
  - Ensure response IDs are stable per request and only one successful terminal event is emitted.
  - Reuse the existing non-streaming assembly path through force-stream behavior.
  - Add tests for split/interleaved text and reasoning, native usage, estimated usage fallback labeling, normal/length stop, empty output, non-streaming assembly, and turn-ended ordering.
  - Verify: response translation tests pass for streaming and non-streaming clients.

- [ ] 9. Implement client-side Cursor tool-call streaming
  - Decode Agent interaction MCP/tool-call start, delta, and completion messages.
  - Map each call to stable OpenAI ID/index; preserve non-empty names, resolve documented continuation forms, and accumulate argument state.
  - Detect cumulative JSON snapshots and emit only the un-emitted suffix; support independent parallel calls and reject malformed new calls safely.
  - Finish with `tool_calls` and preserve tool call state for replay.
  - Add tests for initial call, incremental/cumulative arguments, ID/name omissions, multiple calls, malformed calls, mixed text/tools, completion, and no duplicate bytes.
  - Verify: tool streaming tests pass.

- [ ] 10. Implement tool-result continuation via safe replay
  - Extend request translation to consume canonical assistant `tool_calls` plus `role: tool` results and replay them through the Agent conversation protocol.
  - Map original OpenAI tool-call IDs to Cursor identities without executing any tool on 9router.
  - Add tests for one and parallel tool-result follow-up turns, unknown/mismatched IDs, retry-safe replay, and client errors.
  - Verify: an integration mock completes request → tool call → client result → final assistant response solely through replay.

- [ ] 11. Add bounded native inline session continuation when required
  - Implement `session.js` with maximum session count, idle TTL, maximum pending calls, connection identity binding, and deterministic close/eviction.
  - Retain an HTTP/2 stream only when the Agent API requires inline native result delivery; encode only matching client-provided native MCP/exec result messages.
  - Fall back to complete replay when no valid local session is available; never deliver a result across connection/session boundaries.
  - Add tests for acquire/release, expiry, capacity eviction, duplicate/missing call IDs, session isolation, timer/resource cleanup, and replay fallback.
  - Verify: session tests and full mock continuation pass.

- [ ] 12. Handle native exec and KV channels without server-side execution
  - Decode native exec requests and map representable user-advertised operations to canonical client-side tool calls.
  - For non-representable native operations, return an explicit native unsupported/rejected result with no server paths, command text, or environment information leaked.
  - Implement request/session-scoped KV get/set responses with SHA-256 IDs, strict type/count/byte limits, expiry, and isolation.
  - Add tests proving shell/read/write/grep/diagnostic/computer-use requests never execute locally, unknown blobs fail safely, and cross-session blobs cannot be read.
  - Verify: native channel safety tests pass.

- [ ] 13. Add safe Cursor CLI image support
  - Implement `images.js` and verified Agent selected-image/blob encoding.
  - Support base64 image data URIs with type, count, and byte validation.
  - Support remote images only through the shared outbound guard with redirect revalidation, DNS/IP protection where supported, timeout, and capped streaming reads.
  - Return sanitized 400 errors for all unsafe/malformed inputs and prevent account rotation.
  - Add tests for valid fixture images, malformed data, oversized/count cap, private/metadata URLs, redirects, DNS/IP rejection, timeout, and cross-request blob isolation.
  - Verify: image safety tests pass. Keep vision capability disabled until live model verification.

- [ ] 14. Implement bounded Cursor CLI model discovery
  - Add HTTP/2 generated-protobuf `AgentService/GetUsableModels` query using only the selected credential and CLI headers.
  - Validate/de-duplicate discovered IDs, normalize documented parameterized models, merge trusted metadata, and retain static fallback models on all discovery failures.
  - Add tests for direct/framed unary responses, malformed/compressed/truncated responses, timeout/status failures, duplicate/empty models, and static fallback.
  - Verify: provider model routes expose static and mocked discovered models correctly.

- [ ] 15. Implement Cursor CLI error classification and fallback integration
  - Add `errors.js` that classifies HTTP/2 status, Connect end-stream JSON, trailers, and protocol failures into invalid request/model, auth, temporary account limit, definitive quota, capacity/upstream, and unknown.
  - Sanitize every client/loggable message and preserve `valuableOutput` semantics.
  - Integrate with existing account fallback/cooldown policy without creating a Cursor CLI account pool or permanent deletion path.
  - Add tests for pre-output auth/rate/quota/capacity/invalid request, post-output no-replay, malformed trailers, and secret-redaction fixtures.
  - Verify: focused fallback tests pass.

- [ ] 16. Complete dashboard and API integration
  - Ensure dashboard OAuth connection form, status, reconnect flow, model selector, and model test routing recognize `cursor-cli` independently from Cursor IDE.
  - Ensure canonical OpenAI and Anthropic routes resolve Cursor CLI models, API-key ACL filtering, model discovery routes, and connection selection correctly.
  - Add focused dashboard/model-route/API integration tests with mocked OAuth and Agent responses.
  - Verify: API routes return canonical results and no internal OAuth/session information.

- [ ] 17. Run focused verification and regression suite
  - Run all new Cursor CLI unit/integration tests plus existing Cursor IDE tests, relevant OAuth tests, provider baselines, alias validation, model-route tests, tool translation tests, and account fallback tests.
  - Run `npm run build` with Windows environment isolation as required by repository guidance.
  - Review generated bindings and ensure no credentials, runtime data, or local config are included.
  - Verify: all focused tests and build pass before deployment.

- [ ] 18. Perform hosted end-to-end acceptance
  - Deploy/reload the completed build and connect an authorized Cursor CLI account through dashboard OAuth.
  - Verify a real selected Cursor CLI model returns a valid simple canonical response.
  - Verify a reasoning-capable model response, a controlled tool-call followed by client-supplied tool result, model discovery, and, if enabled, controlled image semantics.
  - Verify no hosted logs/responses disclose credentials and no server-side tool execution occurs.
  - Record exact observed acceptance evidence in the Cursor CLI Kiro spec and Multi Brain handoff.
  - Verify: hosted acceptance passes before marking the provider complete.

- [ ] 19. Finalize documentation and maintenance contracts
  - Update `AGENTS.md` ownership map, Cursor CLI OAuth/protocol/update procedure, safe upstream merge instructions, generated protobuf replacement procedure, and tool-execution boundary.
  - Update Kiro requirements/design with any verified protocol deviations discovered during implementation; do not leave design assumptions uncorrected.
  - Add concise Multi Brain handoff entry with changed files, verification commands, live acceptance results, and future schema/version risks.
  - Verify: documentation accurately reflects the shipped implementation and no unsupported capability is advertised.
