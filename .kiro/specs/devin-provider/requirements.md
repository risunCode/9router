# Requirements Document

## Introduction

This specification defines a native Devin provider integration for 9router. Users supply only a Devin session token as a provider credential. The integration reuses 9router's existing credential storage, account selection, fallback, request translation, image/tool handling, streaming, and usage infrastructure while adapting Devin's Codeium Connect/protobuf protocol behind a dedicated executor.

The initial supported model is the verified Free-tier model `swe-1-6-slow`. Model discovery may supplement this canonical model only when the upstream discovery endpoint returns a valid model list for the selected credential.

## Requirements

### Requirement 1: Provider registration and credential setup

**User Story:** As a 9router user, I want to add Devin with only my session token, so that I can use Devin without maintaining a separate account file or router process.

#### Acceptance Criteria

1. WHEN a user adds a Devin connection THEN 9router SHALL require only a Devin session token as the credential.
2. WHEN the supplied credential omits the `devin-session-token$` prefix THEN the Devin executor SHALL add the prefix before contacting Devin.
3. WHEN the supplied credential already contains the `devin-session-token$` prefix THEN the Devin executor SHALL use exactly one prefix.
4. WHERE Devin is registered THEN 9router SHALL use its existing connection database, provider UI, credential selection, and proxy configuration.
5. WHERE Devin credentials are processed THEN 9router SHALL NOT write session tokens, exchanged user JWTs, or complete authorization headers to application logs or client responses.
6. WHERE Devin is integrated THEN the system SHALL NOT require `account.toml`, a file watcher, a standalone DevinRouter process, or a second account pool.

### Requirement 2: Model availability and vision capability

**User Story:** As a client, I want an accurate Devin model listing, so that I only select models supported by my account.

#### Acceptance Criteria

1. WHERE the initial Devin provider is registered THEN 9router SHALL expose `swe-1-6-slow` as the canonical verified model.
2. WHERE `swe-1-6-slow` is described THEN its upstream identifier SHALL use hyphens exactly as `swe-1-6-slow`.
3. WHERE model capabilities are resolved THEN `swe-1-6-slow` SHALL be marked as supporting image input.
4. WHEN a Devin model discovery request succeeds with a valid non-empty model list THEN 9router MAY return the discovered models in addition to or in place of the canonical fallback according to existing provider-model conventions.
5. WHEN model discovery is unavailable, unauthorized, malformed, or empty THEN 9router SHALL return the canonical `swe-1-6-slow` model without failing provider setup.
6. WHEN a request selects an unsupported Devin model THEN 9router SHALL return a clear client error and SHALL NOT rotate through every account for the same invalid model.

### Requirement 3: Native Devin authentication and transport

**User Story:** As a client, I want 9router to communicate directly with Devin, so that requests do not depend on a CLI subprocess.

#### Acceptance Criteria

1. WHEN a Devin request begins THEN the executor SHALL exchange the selected normalized session token through Devin's `GetUserJwt` endpoint.
2. WHEN the auth response provides a valid custom API server URL THEN the executor SHALL use that URL for the chat request subject to 9router's existing transport and proxy safety rules.
3. WHEN authentication succeeds THEN the executor SHALL construct a protobuf `GetChatMessageRequest` containing the selected model, conversation context, generation configuration, and required metadata.
4. WHEN sending the chat request THEN the executor SHALL encode it using Devin's Connect protocol framing and supported compression.
5. WHILE receiving a Devin response stream THE executor SHALL incrementally parse Connect frames even when network chunks split or combine frame boundaries.
6. WHEN a frame advertises a payload larger than the configured safe maximum THEN the executor SHALL terminate the request with a protocol error before allocating an unbounded payload.
7. WHERE HTTP requests are made THEN the executor SHALL use 9router's proxy-aware transport and honor the request abort signal.
8. WHERE Devin is integrated THEN the executor SHALL communicate directly with the upstream API and SHALL NOT spawn `devin`, `devin acp`, or another subprocess.

### Requirement 4: Request compatibility and existing conversion pipeline

**User Story:** As an API client, I want to call Devin through 9router's existing OpenAI and Anthropic endpoints, so that no Devin-specific client adapter is required.

#### Acceptance Criteria

1. WHEN a supported OpenAI-format request targets Devin THEN 9router SHALL translate and execute it through the existing request pipeline.
2. WHEN a supported Anthropic-format request targets Devin THEN 9router SHALL translate and execute it through the existing request pipeline.
3. WHEN a request contains supported tool definitions or tool history THEN 9router SHALL preserve their semantics through its existing tool conversion pipeline and the Devin request adapter.
4. WHEN a request contains supported image content THEN 9router SHALL preserve the image input through its existing multimodal conversion pipeline and encode it in the Devin request format.
5. WHERE conversion is already implemented generically by 9router THEN the Devin integration SHALL reuse it rather than introduce parallel OpenAI, Anthropic, tool-call, or image conversion systems.
6. WHEN generation options are supported by Devin THEN the executor SHALL preserve their effective values; unsupported client fields SHALL be removed or rejected consistently with existing executor conventions.

### Requirement 5: Streaming and non-streaming responses

**User Story:** As an API client, I want standard 9router responses, so that Devin behaves like other providers.

#### Acceptance Criteria

1. WHILE Devin emits text deltas THE executor SHALL convert them into the canonical streaming representation consumed by 9router.
2. WHILE Devin emits reasoning deltas THE executor SHALL preserve them through 9router's existing thinking/reasoning response path.
3. WHEN Devin emits a tool call THEN the executor SHALL preserve a stable tool-call ID, function name, arguments, and tool index across emitted deltas.
4. WHEN Devin emits usage information THEN the executor SHALL map input and output token counts into 9router's canonical usage representation.
5. WHEN Devin reports maximum-token termination THEN the client response SHALL use the appropriate length stop reason; otherwise successful completion SHALL use the normal stop reason.
6. WHEN a client requests a non-streaming response THEN 9router SHALL assemble the Devin stream through its existing non-streaming handler and return the requested API format.
7. WHEN the client disconnects or aborts THEN the upstream Devin request SHALL be cancelled and the executor SHALL stop producing output.

### Requirement 6: Account selection, retry, and failover

**User Story:** As a user with multiple Devin connections, I want 9router to select and fail over accounts safely, so that transient account limits can recover without duplicate output or permanent credential loss.

#### Acceptance Criteria

1. WHEN a Devin request is initiated THEN account selection SHALL use 9router's existing credential selection and configured rotation strategy.
2. WHEN Devin reports a temporary per-account message or rate limit before valuable output is sent THEN 9router SHALL make the account temporarily unavailable and MAY retry the next eligible Devin connection.
3. WHEN Devin reports explicit quota, usage-limit, or credit exhaustion before valuable output is sent THEN 9router SHALL apply an account/model cooldown using its existing fallback state rather than permanently deleting the connection.
4. WHEN Devin returns an authentication failure THEN 9router SHALL follow its existing credential refresh/fallback policy and SHALL NOT permanently disable the connection solely because of one failed request.
5. WHEN Devin reports global model capacity, an upstream server error, or a network failure THEN 9router SHALL use bounded existing retry/fallback behavior and SHALL NOT classify the condition as definitive account quota exhaustion.
6. WHEN an invalid request or unsupported model error occurs THEN 9router SHALL return the error without cycling through all Devin connections.
7. WHEN valuable text, reasoning, or tool output has already been forwarded to the client THEN 9router SHALL NOT transparently restart the request on another account.
8. WHERE retries occur THEN the combined executor and account fallback flow SHALL remain bounded and SHALL NOT retry the same request indefinitely.
9. WHEN a fallback account completes a non-streaming request THEN any diagnostic account identifier SHALL use existing internal connection metadata and SHALL NOT expose the token or exchanged JWT.

### Requirement 7: Error classification and client safety

**User Story:** As an operator, I want Devin failures classified accurately, so that account state and client errors remain trustworthy.

#### Acceptance Criteria

1. WHEN HTTP status indicates an error THEN the executor SHALL parse the upstream body without assuming it is valid JSON.
2. WHEN a Connect terminal/trailer frame contains an error THEN the executor SHALL classify it using the same Devin error rules as HTTP failures.
3. WHEN an error contains generic `429`, capacity, overloaded, or resource-exhausted wording without explicit account quota evidence THEN the executor SHALL NOT treat it as permanent quota exhaustion.
4. WHEN an error explicitly states quota, usage limit, or credits are exhausted, exceeded, depleted, or reached THEN the executor SHALL classify it as definitive account-level exhaustion.
5. WHEN upstream returns unknown or malformed protocol data THEN the executor SHALL return a sanitized provider error without leaking credentials or crashing the server process.
6. WHERE errors are logged THEN logs MAY include provider, model, status, and internal connection ID but SHALL NOT include session tokens, user JWTs, or authorization headers.

### Requirement 8: Model discovery behavior

**User Story:** As a user, I want Devin models to be discoverable when the upstream supports it, so that future Free-tier model changes do not require immediate manual updates.

#### Acceptance Criteria

1. IF the existing Devin discovery implementation can query model configuration with the selected session credential THEN the provider models endpoint SHALL use that implementation through a bounded request.
2. WHEN discovered model data is returned THEN 9router SHALL validate identifiers and omit malformed entries before exposing them.
3. WHEN discovery fails THEN the failure SHALL NOT mark the connection unavailable or prevent use of `swe-1-6-slow`.
4. WHERE discovery is cached THEN it SHALL use 9router's existing provider-model cache conventions and SHALL NOT persist exchanged user JWTs.
5. IF model discovery cannot be integrated without duplicating credential selection or weakening error isolation THEN the initial implementation SHALL expose only `swe-1-6-slow`.

### Requirement 9: Verification and regression protection

**User Story:** As a maintainer, I want focused automated coverage, so that future provider and protocol changes do not silently break Devin.

#### Acceptance Criteria

1. WHEN the provider registry is validated THEN the Devin entry, alias, model, credential field, and vision capability SHALL pass existing registry baseline checks.
2. WHEN token normalization is tested THEN raw, prefixed, empty, and repeated-prefix inputs SHALL have deterministic safe outcomes.
3. WHEN transport tests run THEN auth exchange, custom server URL handling, request framing, gzip handling, split/multiple response frames, oversized frames, trailers, and abort behavior SHALL be covered without real upstream calls.
4. WHEN response tests run THEN text, reasoning, tool calls, image-bearing requests, usage, normal stop, and max-token stop SHALL be covered.
5. WHEN fallback tests run THEN temporary limit, explicit quota exhaustion, auth failure, capacity failure, invalid model, pre-output retry, and post-output no-retry behavior SHALL be covered.
6. WHERE automated tests run THEN all external Devin and Codeium I/O SHALL be mocked and no real session credential SHALL appear in fixtures, snapshots, logs, or committed files.
7. WHEN implementation is complete THEN focused Devin tests, affected provider baselines, and the application build or equivalent project verification SHALL pass.
