# Cursor adaptation breakdown

## Scope
Compared 9router's existing Cursor provider with local OMP and OmniRoute references under DevinRouter/z-references.

## Confirmed protocol families
- Existing 9router Cursor path: `https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools`; custom hand-rolled protobuf in `open-sse/utils/cursorProtobuf.js`, HTTP/2 preferred in `open-sse/executors/cursor.js`, Connect frame `[flags:1][length:4][payload]`.
- OMP/OmniRoute agent path: `https://api2.cursor.sh/agent.v1.AgentService/Run`; generated `@bufbuild/protobuf` bindings from `agent.proto`; bidirectional HTTP/2 stream with `AgentClientMessage`/`AgentServerMessage`, heartbeat, interaction, exec, KV, and checkpoint channels.
- These are not interchangeable schemas. Devin's Connect framing and Buf runtime are reusable; Devin proto bindings/auth/message schema are not reusable for Cursor.

## OMP facts
- `oh-my-pi-main/packages/ai/src/providers/cursor.ts`: `streamCursor`, HTTP/2 `AgentService/Run`, bearer access token, `x-ghost-mode`, CLI client version/type, 5-second `ClientHeartbeat`, incremental frame decode, Connect end-stream JSON errors and HTTP/2 trailers.
- Request is `AgentClientMessage{runRequest: AgentRunRequest}` with conversation state/action/model details/MCP tools. Responses include text/thinking/tool interaction updates, server-driven exec requests, KV blob requests, checkpoints, and turn-ended.
- Generated schema: `packages/catalog/src/discovery/cursor-gen/agent_pb.ts`; source schema: `packages/ai/src/providers/cursor/proto/agent.proto`.
- OAuth: PKCE login/poll and refresh in `packages/ai/src/registry/oauth/cursor.ts`; model discovery uses `GetUsableModels` in `packages/catalog/src/discovery/cursor.ts`.
- OMP executes local tools through the exec channel; it is not a plain OpenAI tool-call stream. 9router must not execute tools server-side unless intentionally adding a client/tool bridge.

## OmniRoute facts
- `OmniRoute-3.8.46/open-sse/executors/cursor.ts` is a large stateful agent executor with `CursorSessionManager`, tool result reinjection, native exec tool handlers, KV blob storage, cold-resume flattening, Composer thinking handling, and stream state machine.
- `open-sse/utils/cursorAgentProtobuf.ts` is hand-rolled agent wire codec; `utils/cursorAgentProtobuf/wire.ts` is the extracted primitive layer. `open-sse/utils/cursorImages.ts` has strict SSRF/size/redirect/DNS protections.
- `executors/cursor/prompt.ts` maps unsupported OpenAI options into prompt constraints and tool-choice directives. `executors/cursor/composer.ts` strips private thinking and final sentinels.
- Request/response translators are mostly canonicalization; response translator is passthrough because executor emits OpenAI chunks.
- Test coverage includes framing/bounds, model normalization, text/tool deltas, parallel calls, session lifecycle/TTL, image security, Composer behavior, and error paths.

## 9router baseline
- Existing `open-sse/executors/cursor.js` already supports ChatService, text/thinking, tool-call accumulation, non-streaming assembly, Composer visible suffix, and HTTP/2/fetch fallback.
- Existing `open-sse/utils/cursorProtobuf.js` uses guessed/maintained field numbers, no generated schema, and currently has weaker bounds handling than OmniRoute's checked length decoder.
- Existing registry is OAuth with ChatService endpoint and static models (`open-sse/providers/registry/cursor.js`). `open-sse/utils/cursorChecksum.js` builds Cursor auth headers/checksum/session ID.
- Existing `open-sse/translator/request/openai-to-cursor.js` converts tool results to XML text and strips some OpenAI fields; it does not implement OMP's agent exec/KV protocol.
- Devin baseline (`open-sse/executors/devin/*`) proves 9router can own Buf-generated protobuf, Connect framing, bounded streaming, pre-output probe, post-output no-replay, and canonical OpenAI SSE. It does not prove Cursor auth or agent schema compatibility.

## Recommended adaptation decision
1. Preserve existing Cursor ChatService executor as the low-risk path unless the target explicitly requires Cursor Agent semantics.
2. If adopting OMP/OmniRoute agent behavior, add a separate Cursor Agent executor/protocol module and endpoint, not a silent schema swap in the current ChatService codec.
3. Reuse Devin patterns: generated binding dependency closure, isolated `protocol/request/response/errors`, proxy-aware HTTP/2 transport, bounded frames, pre-output fallback probe, valuable-output post-error behavior, canonical OpenAI SSE.
4. Implement agent MVP statelessly first: text + reasoning + client tool-call deltas, no server-side exec, no KV blob persistence beyond request-local data. Return tool calls to client and require the next request to replay history.
5. Add stateful session manager only if Cursor refuses replayed context or requires inline tool-result continuation. If added, use bounded TTL/max sessions and explicit cleanup, following OmniRoute.
6. Do not copy OMP/OmniRoute's local tool execution bridge, CLI/ACP assumptions, or broad generated dependency closure without proving required messages.
7. Add strict protobuf length bounds, unknown-field tolerance, image SSRF/size limits, model discovery only after static path works, and focused protocol tests before hosted testing.

## Open questions before implementation
- Which Cursor contract is desired: current ChatService/OpenAI tool stream or AgentService/Run with native exec channel?
- Credential input: existing OAuth access token is sufficient for both references; no Devin-style session-token exchange should be invented.
- Whether hosted Cursor account accepts agent endpoint for the stored OAuth token and which client version/model IDs remain valid.
- Whether images are required for first cut; agent path uses KV blobs/SelectedImage, while current ChatService path has no equivalent proven image path.
