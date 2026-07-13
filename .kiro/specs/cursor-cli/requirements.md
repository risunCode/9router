# Cursor CLI Provider Requirements

## Introduction

This specification defines a complete native **Cursor CLI** provider for 9router. It is separate from the existing `cursor` / `cu` Cursor IDE provider and uses the Cursor Agent API (`AgentService/Run`) modeled on the verified Oh My Pi (OMP) protocol reference.

The goal is an end-to-end production integration: a user can authorize a Cursor account through 9router OAuth, select Cursor CLI models, call it through existing OpenAI- and Anthropic-compatible APIs, receive standard text/reasoning/tool-call responses, continue tool-use turns correctly, and verify a real hosted model request after deployment. The implementation must not weaken the existing Cursor IDE provider or execute user tools on the hosted 9router server.

## Requirements

### Requirement 1: Separate provider identity and compatibility

**User Story:** As a 9router operator, I want Cursor CLI to be a distinct provider from Cursor IDE, so that I can use both protocols without regressions or ambiguous configuration.

#### Acceptance Criteria

1. WHERE Cursor CLI is registered THEN 9router SHALL expose it under provider ID `cursor-cli` and SHALL NOT repurpose the existing `cursor` or `cu` provider identifiers.
2. WHERE Cursor CLI is displayed in the dashboard THEN the system SHALL identify it as `Cursor CLI` and SHALL use a distinct alias that does not collide with the Cursor IDE alias `cu`.
3. WHEN requests target the existing `cursor` or `cu` provider THEN 9router SHALL retain the existing Cursor IDE ChatService endpoint, checksum/machine-ID authentication behavior, registry entry, and request/response codec unchanged.
4. WHERE Cursor CLI is registered THEN its transport SHALL use `https://api2.cursor.sh/agent.v1.AgentService/Run` rather than the Cursor IDE ChatService path.
5. WHERE the Cursor CLI protocol is implemented THEN provider-specific Agent API code SHALL be isolated from the existing Cursor IDE executor and hand-written ChatService protobuf codec.
6. WHEN an unsupported Cursor CLI model is requested THEN 9router SHALL return a client error without rotating through additional Cursor CLI connections.

### Requirement 2: OAuth authorization and credential lifecycle

**User Story:** As a user, I want to connect Cursor CLI through the dashboard OAuth flow, so that 9router can securely use and refresh my Cursor CLI authorization.

#### Acceptance Criteria

1. WHEN a user starts Cursor CLI authorization THEN 9router SHALL generate a PKCE verifier, challenge, and one-time UUID.
2. WHEN authorization begins THEN 9router SHALL direct the user to Cursor's CLI login deep-link endpoint with the generated challenge, UUID, login mode, and CLI redirect target.
3. WHILE the user has not completed authorization THEN 9router SHALL poll Cursor's authorization endpoint with bounded retries and backoff.
4. WHEN Cursor returns valid authorization data THEN 9router SHALL store the access token, refresh token, and derived expiry through the existing provider-connection credential mechanism.
5. WHEN a Cursor CLI access token is close to expiry or rejected as refreshable THEN 9router SHALL refresh it through Cursor's supported token-exchange endpoint and update the selected connection through existing OAuth credential persistence.
6. WHEN OAuth polling, token exchange, or token decoding fails THEN 9router SHALL return a sanitized actionable error and SHALL NOT log or expose access tokens, refresh tokens, PKCE verifiers, authorization headers, or full polling URLs.
7. WHERE Cursor CLI OAuth is implemented THEN it SHALL reuse the existing 9router OAuth route, callback, connection, refresh, proxy, and account-selection conventions instead of creating a second credential store.
8. WHERE a stored connection contains only a valid Cursor access token and no refresh token THEN 9router SHALL use the access token until it is invalid or expired, then return a clear reconnection error rather than corrupting or deleting the connection.

### Requirement 3: Native Agent API transport and protobuf bindings

**User Story:** As a client, I want 9router to communicate directly with the Cursor CLI Agent API, so that requests are compatible with Cursor CLI rather than Cursor IDE emulation.

#### Acceptance Criteria

1. WHEN a Cursor CLI request begins THEN 9router SHALL use HTTP/2 and SHALL not silently downgrade the Agent API request to an incompatible HTTP/1.1 transport.
2. WHEN establishing the Agent API request THEN 9router SHALL send the required CLI identity headers including bearer authorization, Connect protocol version, CLI client type, compatible client version, ghost-mode setting, request ID, and HTTP/2 trailer support.
3. WHEN serializing or parsing Agent API messages THEN 9router SHALL use generated protobuf bindings from a verified OMP-derived Cursor `agent.proto` dependency closure and SHALL NOT hand-author Agent protobuf field numbers.
4. WHERE generated Cursor protobuf bindings are stored THEN they SHALL be isolated under the Cursor CLI protocol directory, imported with Node-compatible module extensions, and never hand-edited.
5. WHEN sending or receiving Connect frames THEN 9router SHALL support the standard one-byte flag plus four-byte big-endian payload length framing and SHALL process stream chunks that split or combine frame boundaries.
6. WHEN a Connect frame advertises a payload above the configured safe cap, has invalid flags, or ends with incomplete bytes THEN 9router SHALL terminate the request with a sanitized protocol error before allocating or decoding unbounded data.
7. WHEN Cursor sends an end-stream frame or non-success HTTP/2 trailers THEN 9router SHALL parse the structured error safely and classify it consistently with pre-output versus post-output fallback policy.
8. WHILE a Cursor CLI Agent stream is active THEN 9router SHALL send bounded periodic client heartbeats and SHALL stop them when the stream ends, errors, or is aborted.
9. WHEN a request is cancelled by the client THEN 9router SHALL close the HTTP/2 stream/session, cancel timers, and stop emitting output.
10. WHERE outbound transport is used THEN Cursor CLI SHALL honor 9router's configured per-connection proxy and request abort signal.

### Requirement 4: Canonical request translation and conversation replay

**User Story:** As an OpenAI- or Anthropic-compatible API client, I want to send normal messages to Cursor CLI through 9router, so that I need no Cursor-specific client adapter.

#### Acceptance Criteria

1. WHEN an OpenAI-compatible chat-completion request targets Cursor CLI THEN 9router SHALL normalize it through the existing canonical request pipeline before building the Agent protobuf request.
2. WHEN an Anthropic-compatible request targets Cursor CLI THEN 9router SHALL reuse the existing Anthropic-to-canonical conversion before building the Agent protobuf request.
3. WHEN canonical messages include system, developer, user, assistant, and tool-result history THEN 9router SHALL preserve their chronological semantics in the Cursor Agent conversation/action representation.
4. WHEN a request starts a conversation THEN 9router SHALL generate or accept a stable conversation identifier without exposing provider-internal state in client responses.
5. WHEN a request continues a conversation after a completed tool call THEN 9router SHALL preserve the assistant tool call and matching client tool result in the replayed Cursor context.
6. WHEN the Cursor Agent API cannot continue a replayed context statelessly THEN 9router SHALL use a bounded, TTL-evicted session mechanism that retains only the connection state necessary to deliver pending tool results and falls back safely to full replay when the session is unavailable.
7. WHEN clients pass supported generation controls including model, max output, reasoning effort, stop sequences, response format, and tool choice THEN 9router SHALL map them to native Agent fields where supported or to explicit, documented prompt constraints where the Agent API has no equivalent.
8. WHEN a requested control cannot be represented reliably and cannot be constrained safely THEN 9router SHALL reject it as a client error rather than silently claim semantic support.
9. WHERE canonical message conversion already exists in 9router THEN Cursor CLI SHALL reuse that conversion rather than create a parallel OpenAI or Anthropic API surface.

### Requirement 5: Text, reasoning, usage, and completion translation

**User Story:** As an API client, I want Cursor CLI output in standard 9router response formats, so that downstream clients work without modification.

#### Acceptance Criteria

1. WHILE Cursor emits interaction text deltas THEN 9router SHALL emit canonical OpenAI-compatible SSE content deltas in original order.
2. WHILE Cursor emits reasoning/thinking deltas THEN 9router SHALL preserve them through 9router's canonical reasoning output path without exposing private protocol markers or unrelated internal state.
3. WHEN Cursor emits usage or token deltas sufficient to compute usage THEN 9router SHALL map them to canonical prompt, completion, and total token usage; where authoritative usage is absent it SHALL follow existing 9router estimation conventions without presenting an estimate as upstream-reported usage.
4. WHEN Cursor ends a turn normally, by length, or through tool use THEN 9router SHALL emit the corresponding canonical OpenAI finish reason and exactly one terminal `[DONE]` event for streaming clients.
5. WHEN a client requests a non-streaming response THEN 9router SHALL assemble the native Cursor stream through existing non-streaming behavior and return the requested canonical response shape.
6. WHEN an upstream failure occurs after text, reasoning, or tool-call output has been emitted THEN 9router SHALL terminate the current response with a sanitized terminal stream error and SHALL NOT replay the request on another account.
7. WHEN an upstream failure occurs before valuable output then existing account fallback is eligible THEN 9router SHALL expose no partial assistant response from the failed attempt.

### Requirement 6: Client-side tool-call contract

**User Story:** As an agent client, I want Cursor CLI tool requests translated into OpenAI tool calls, so that my local client can execute tools in its own workspace.

#### Acceptance Criteria

1. WHEN the Cursor Agent interaction channel emits an MCP or tool-call start THEN 9router SHALL emit a canonical OpenAI `tool_calls[index]` start delta with a stable client-visible tool-call ID and non-empty function name.
2. WHILE Cursor streams tool-call argument updates THEN 9router SHALL preserve one stable tool-call index per call and emit only the previously un-emitted argument suffix.
3. WHEN Cursor sends cumulative argument snapshots rather than incremental fragments THEN 9router SHALL detect the known prefix and SHALL NOT duplicate argument bytes in canonical OpenAI output.
4. WHEN Cursor sends a continuation without a new ID or name THEN 9router SHALL associate it with the active known tool call; a brand-new call lacking both a resolvable ID and a non-empty name SHALL be rejected as a sanitized protocol error.
5. WHEN Cursor emits multiple tool calls in one turn THEN 9router SHALL preserve their independent IDs, indexes, argument buffers, and finish the turn with `tool_calls`.
6. WHERE Cursor CLI emits tool calls THEN 9router SHALL NOT execute shell commands, file operations, browser actions, MCP tools, or other provider-requested tools on the hosted 9router server.
7. WHEN a client submits a canonical `role: "tool"` result for a prior Cursor CLI tool call THEN 9router SHALL map it to the appropriate Cursor continuation/replay mechanism while preserving the original tool-call identity.
8. WHEN Cursor requires an inline result on a retained bidirectional stream THEN 9router SHALL send only the matching client-provided result through the native exec/MCP result channel; it SHALL not synthesize or execute a result locally.
9. WHEN an inline session cannot be found, is expired, is owned by another process, or has no matching pending call THEN 9router SHALL safely fall back to complete context replay or return a clear client error; it SHALL not send a result to an unrelated session.

### Requirement 7: Native exec, KV, and session safety

**User Story:** As an operator, I want native Cursor Agent channels handled safely, so that protocol-required behavior does not create arbitrary server-side execution or unbounded state.

#### Acceptance Criteria

1. WHEN Cursor sends a native exec request for read, write, shell, grep, diagnostics, computer use, or another local capability THEN 9router SHALL not execute it and SHALL not grant the upstream access to 9router's filesystem, network, process environment, credentials, or deployment host.
2. WHEN an exec request corresponds to an advertised client tool THEN 9router SHALL translate it into the client-side tool-call contract or, if the API contract cannot represent it, return a structured unsupported-tool result to Cursor without exposing server internals.
3. WHEN Cursor sends a KV get/set request required for active conversation state, image references, or request payloads THEN 9router SHALL resolve only request-scoped or explicitly retained blobs under bounded size/count/TTL limits.
4. WHEN a KV request references an unknown or expired blob THEN 9router SHALL return the native not-found/error response without crashing the stream or leaking data from another request/connection.
5. WHERE a Cursor CLI session store is necessary THEN it SHALL be bounded by maximum sessions, maximum pending calls, idle TTL, and memory-safe blob limits, and SHALL clean up HTTP/2 streams/timers on eviction.
6. WHERE 9router runs more than one process or replica THEN session affinity absence SHALL degrade to safe context replay or a clear retryable response; it SHALL not assume in-memory state is globally available.
7. WHEN 9router emits synthesized OpenAI tool-call blocks for native Cursor exec requests THEN the provider shall mark them as already provider-resolved so that no server-side execution loop can execute them again.

### Requirement 8: Vision and binary payload safety

**User Story:** As a client, I want supported Cursor CLI image input to work safely, so that vision-capable Cursor models can receive images without exposing the router to SSRF or memory exhaustion.

#### Acceptance Criteria

1. WHEN a canonical request contains a supported base64 image data URI THEN 9router SHALL validate media type, decode it under a strict per-image size cap, and encode it through Cursor Agent's verified image/blob representation.
2. WHEN a canonical request contains a remote image URL THEN 9router SHALL use 9router's outbound URL safety guard, reject private/link-local/metadata destinations, validate every redirect, apply DNS rebinding defense where supported, enforce a request timeout, and stream-read under the same size cap.
3. WHEN the request exceeds the configured image count or byte limits THEN 9router SHALL return a client error before opening the Cursor Agent request.
4. WHEN an image payload is malformed, unsupported, unsafe, or cannot be fetched THEN 9router SHALL return a sanitized client error and SHALL NOT rotate Cursor CLI accounts.
5. WHERE Cursor image support has not yet been verified against a real authorized Agent API model THEN 9router SHALL not advertise vision as a confirmed capability until the live contract is verified.

### Requirement 9: Model discovery and capabilities

**User Story:** As a user, I want models available to my Cursor CLI account to appear accurately, so that I can select usable Agent models.

#### Acceptance Criteria

1. WHERE Cursor CLI is registered THEN 9router SHALL provide a bounded static fallback model set sufficient to create and validate a connection when live discovery is unavailable.
2. WHEN the selected Cursor CLI credential can call `AgentService/GetUsableModels` successfully THEN 9router SHALL query that endpoint through HTTP/2 using the selected credential and compatible CLI identity headers.
3. WHEN live discovery returns models THEN 9router SHALL validate, de-duplicate, normalize, and expose only non-empty model identifiers.
4. WHEN discovery fails, times out, returns malformed protobuf, or yields no models THEN 9router SHALL retain the static fallback models and SHALL not mark the connection unavailable.
5. WHERE model metadata is returned THEN 9router SHALL map model name, reasoning support, context/output limits, and modalities only when verified by the upstream data or documented static metadata.
6. WHEN a model requires a special normalized identifier or parameter representation, such as a Cursor `-fast` variant, THEN 9router SHALL encode it according to the verified Agent schema while retaining the model selected by the client.
7. WHERE model discovery is implemented THEN it SHALL not independently select another provider credential or mutate account fallback state.

### Requirement 10: Errors, account fallback, and credential safety

**User Story:** As an operator, I want Cursor CLI failure handling to preserve account health and avoid duplicate output or credential exposure.

#### Acceptance Criteria

1. WHEN Cursor returns authentication or authorization failure before output THEN 9router SHALL use existing refresh and account fallback policy and SHALL not permanently delete a connection after one failure.
2. WHEN Cursor explicitly reports a temporary account or message rate limit before output THEN 9router SHALL make the selected connection eligible for existing bounded cooldown/fallback behavior.
3. WHEN Cursor explicitly reports quota, credits, or usage exhaustion before output THEN 9router SHALL apply existing longer account/model cooldown behavior and SHALL not treat the condition as permanent credential deletion.
4. WHEN Cursor reports generic resource exhaustion, capacity, overload, unavailable service, transport failure, or HTTP/2 failure without account-specific evidence THEN 9router SHALL preserve that distinction and SHALL not classify it as definitive quota exhaustion.
5. WHEN Cursor reports invalid model, invalid request, malformed client tool data, unsupported image input, or unsupported option THEN 9router SHALL return a client error and SHALL not rotate through all Cursor CLI connections.
6. WHEN a failure occurs after valuable output THEN 9router SHALL set/retain the valuable-output condition so existing fallback infrastructure never replays side-effecting or partially visible turns.
7. WHERE errors, diagnostics, logs, fixtures, snapshots, and test failures are produced THEN they SHALL never contain Cursor access tokens, refresh tokens, authorization headers, PKCE verifier/challenge values, session blobs, or user image contents.

### Requirement 11: Complete verification and live acceptance

**User Story:** As a maintainer, I want proof that Cursor CLI works from authorization through a real model response, so that the provider is complete rather than a protocol scaffold.

#### Acceptance Criteria

1. WHEN implementation tests run THEN all Cursor CLI external I/O SHALL be mocked and focused tests SHALL cover OAuth PKCE/poll/refresh, generated protobuf request construction, HTTP/2 headers/framing, split/coalesced frames, oversized/truncated frames, heartbeat lifecycle, end-stream/trailer errors, cancellation, and credential sanitization.
2. WHEN request/response tests run THEN they SHALL cover system/developer/user/assistant/tool replay, text, reasoning, usage, normal/length/tool-call completion, single/multiple tool calls, cumulative argument snapshots, missing continuation fields, tool results, and non-streaming assembly.
3. WHEN session/KV/image behavior is implemented THEN tests SHALL cover TTL/max-session eviction, unrelated-session isolation, request-scoped blob access, stale calls, SSRF rejection, redirects, DNS/IP guards, count/size caps, and safe client errors.
4. WHEN account fallback tests run THEN they SHALL cover pre-output authentication failure, temporary rate limit, definitive quota, generic capacity, invalid request/model, post-output no-replay, and selected-credential-only execution.
5. WHEN provider registration changes THEN focused registry, capability, alias, model-route, and baseline tests SHALL pass without changing the Cursor IDE provider contract.
6. WHEN the implementation is ready for hosted verification and an authorized Cursor CLI account is available THEN a real deployed 9router instance SHALL complete an OAuth-backed request to a selected Cursor CLI model and return a valid canonical response.
7. WHEN hosted verification exercises tools or vision THEN it SHALL use non-sensitive controlled inputs and confirm the observable client-side tool-call or image behavior; it SHALL not expose credentials or execute untrusted server-side tools.
8. WHEN live verification cannot run because deployment, account authorization, or user interaction is unavailable THEN implementation SHALL remain explicitly pending live acceptance and SHALL not be declared complete.
9. WHEN all focused tests and hosted acceptance pass THEN 9router SHALL build successfully and the Cursor CLI provider SHALL be considered complete.
