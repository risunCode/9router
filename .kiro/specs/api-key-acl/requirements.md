# Requirements Document

## Introduction

This feature adds opt-in access control lists (ACLs) to 9router API keys so the router owner can safely share constrained "bansos" keys. Each key can be limited to selected models or combos, a daily token budget, a lifetime token budget, and an expiry time. The Dashboard provides creation, editing, revocation, and usage monitoring.

The design takes relevant ideas from upstream 9router PR #1158—API-key model allowlists, daily token limits, expiry, `/v1/models` filtering, and Dashboard policy controls—but adapts them to this fork's API-key, usage, custom-provider, and all-endpoint architecture. Upstream PR #1681 is reference only for attribution and quota accounting; this feature uses token budgets rather than cost budgets so it works predictably with free providers such as Devin.

## Requirements

### Requirement 1: Backward-compatible API-key policies

**User Story:** As the router owner, I want to optionally attach limits to an API key, so that existing private keys keep working while shared keys can be safely constrained.

#### Acceptance Criteria

1. WHERE an API key has no ACL settings THEN 9router SHALL preserve its current unrestricted behavior.
2. WHEN an administrator creates or updates an API key THEN 9router SHALL accept a normalized policy containing an allowed-model list, daily token limit, lifetime token limit, and expiry timestamp.
3. IF an allowed-model list is empty THEN 9router SHALL treat the key as allowed to access all otherwise available models.
4. IF a daily or lifetime token limit is zero or absent THEN 9router SHALL treat that respective limit as unlimited.
5. IF an expiry timestamp is absent THEN 9router SHALL treat the key as non-expiring.
6. WHEN a policy value is invalid, negative, non-integral, malformed, or exceeds the safe integer range THEN 9router SHALL reject the administration request with `400` and SHALL leave the existing policy unchanged.
7. WHERE an existing database, export, import, or legacy migration contains API keys without ACL fields THEN 9router SHALL migrate and interpret them as unrestricted and non-expiring.
8. WHERE key policy state is stored THEN 9router SHALL store it independently of provider connection credentials.

### Requirement 2: Key validity and expiry

**User Story:** As the router owner, I want shared keys to expire automatically, so that temporary access ends without manual cleanup.

#### Acceptance Criteria

1. WHEN a disabled key is presented THEN 9router SHALL reject it with `401` before provider selection or upstream I/O.
2. WHEN an expired key is presented THEN 9router SHALL reject it with `401` before provider selection or upstream I/O.
3. WHEN a valid key has not expired THEN 9router SHALL preserve the existing API-key authentication flow.
4. WHEN an administrator views a key THEN 9router SHALL display its active, expired, or disabled state without exposing its full secret.
5. WHEN the expiry time passes THEN 9router SHALL deny subsequent requests without requiring a scheduled cleanup job.
6. WHERE an expiry error is returned THEN it SHALL not reveal the key secret, connection credentials, or account information.

### Requirement 3: Model and combo allowlist

**User Story:** As the router owner, I want to restrict each shared key to approved models or combos, so that recipients cannot consume unrelated provider capacity.

#### Acceptance Criteria

1. WHEN an API key has a non-empty allowed-model list THEN 9router SHALL allow only exact configured model identifiers, configured combo names, or explicitly configured model aliases.
2. WHEN a request resolves to a model or combo not allowed for the key THEN 9router SHALL reject it with `403`, code `model_not_allowed`, before provider credential selection, account rotation, or upstream I/O.
3. WHEN an allowed entry is a combo THEN 9router SHALL permit routing through that combo and SHALL NOT require every internal fallback member to be separately listed.
4. WHEN an allowed entry is a model alias THEN 9router SHALL resolve the alias using the current alias mapping before evaluating the policy.
5. WHEN an administrator changes an alias, combo, or custom model referenced by a policy THEN 9router SHALL evaluate subsequent requests against the current definition and SHALL fail closed if the referenced target no longer resolves.
6. WHEN an authenticated key requests `/v1/models`, `/v1/models/{kind}`, or model metadata THEN 9router SHALL expose only models and combos allowed by that key.
7. WHEN a key has an empty allowlist THEN model-list endpoints SHALL retain their existing behavior.
8. WHERE a model identifier is compared against a policy THEN comparison SHALL be exact and case-sensitive; wildcard matching SHALL NOT be introduced initially.

### Requirement 4: Token budgets

**User Story:** As the router owner, I want daily and lifetime token caps per shared key, so that access has both a renewable allowance and a hard total allocation.

#### Acceptance Criteria

1. WHEN a key has a daily token limit THEN 9router SHALL track prompt and completion tokens for that key in the server-local calendar day.
2. WHEN a key has a lifetime token limit THEN 9router SHALL track total prompt and completion tokens across its lifetime.
3. WHEN a request would exceed a known remaining quota before execution THEN 9router SHALL reject it with `429`, code `token_quota_exceeded`, and a `Retry-After` header for daily limits.
4. WHEN the daily quota is exhausted THEN 9router SHALL reject subsequent requests until the next server-local midnight.
5. WHEN the lifetime quota is exhausted THEN 9router SHALL reject subsequent requests until an administrator raises, clears, or replaces the limit.
6. WHEN a client supplies `max_tokens` or an equivalent output ceiling THEN preflight quota evaluation SHALL reserve that ceiling plus the request's best available input-token estimate; where a reliable input estimate is unavailable, it SHALL reserve the output ceiling only.
7. WHEN a streaming response completes THEN 9router SHALL atomically record actual usage, release any unused preflight reservation, and prevent subsequent requests from exceeding the applicable cap.
8. WHEN a streaming response is interrupted or returns no usage THEN 9router SHALL preserve a conservative reservation or reconcile it using the best available observed usage; it SHALL not silently reset quota consumption.
9. WHERE parallel requests use the same key THEN quota reservation and settlement SHALL be atomic in SQLite and SHALL not permit unbounded over-allocation.
10. WHERE a key has no token caps THEN quota accounting MAY remain observable but SHALL not block requests.

### Requirement 5: Endpoint coverage and enforcement

**User Story:** As the router owner, I want policy enforcement to be consistent across every externally accessible inference API, so that a recipient cannot bypass restrictions by changing client protocol.

#### Acceptance Criteria

1. WHEN an authenticated request targets OpenAI chat completions, Responses, Anthropic Messages, Ollama chat, or Gemini native chat THEN 9router SHALL apply key validity, model allowlist, and quota policy before routing.
2. WHEN an authenticated request targets embeddings, image generation, TTS, STT, search, or fetch THEN 9router SHALL apply key validity and relevant model allowlist policy before routing; token-budget enforcement SHALL apply whenever the endpoint returns measurable token usage.
3. WHEN a route has no model identifier and the key has a non-empty model allowlist THEN 9router SHALL reject it unless a future explicit endpoint permission grants access.
4. WHEN an endpoint intentionally does not execute inference, such as token counting or voice metadata, THEN it SHALL remain explicitly exempt or be authenticated consistently; it SHALL not accidentally bypass a protected inference route.
5. WHERE existing routes use duplicated authentication code THEN the implementation SHALL centralize ACL evaluation in a shared service and reuse it rather than create divergent per-route policy rules.
6. WHEN a dashboard-local or CLI-token bypass is allowed by existing deployment security rules THEN the implementation SHALL preserve that trusted-admin behavior while preventing an untrusted external request from bypassing a key policy.

### Requirement 6: Dashboard management and monitoring

**User Story:** As the router owner, I want to manage bansos keys from the existing API Key screen, so that I can issue, monitor, edit, pause, and revoke access without database edits.

#### Acceptance Criteria

1. WHEN an administrator creates a key in Dashboard Endpoint/API Keys THEN the form SHALL allow an optional model/combo allowlist, daily token limit, lifetime token limit, and expiry date.
2. WHEN an administrator edits a key THEN the form SHALL allow changing all policy fields without rotating the key secret unless a separate rotation action is selected.
3. WHEN an administrator views a key THEN the list SHALL show active/expired/disabled state, model policy summary, daily usage and remaining quota, lifetime usage and remaining quota, and expiry status.
4. WHEN the key has an empty allowlist or unlimited cap THEN the UI SHALL clearly label the policy as unrestricted or unlimited rather than imply a zero allowance.
5. WHEN the policy list contains models, aliases, or combos THEN the UI SHALL reuse the existing model selection/search components and show only current selectable identifiers.
6. WHEN a policy update is submitted THEN the UI SHALL display validation failures returned by the API and SHALL not discard the user-entered form data.
7. WHERE key values are displayed THEN the UI SHALL retain existing masking/copy behavior and SHALL never reveal a full secret in monitoring or usage summaries.

### Requirement 7: API, export, and observability contracts

**User Story:** As an operator and integrator, I want stable policy APIs and attribution, so that I can automate bansos provisioning and audit consumption.

#### Acceptance Criteria

1. WHEN `POST /api/keys` creates a key THEN it SHALL accept validated policy fields and return the normalized non-secret policy alongside the newly issued secret only in that creation response.
2. WHEN `GET /api/keys` or `GET /api/keys/{id}` returns a key THEN it SHALL include policy state and safe quota summaries while preserving existing secret-handling behavior.
3. WHEN `PUT /api/keys/{id}` updates a policy THEN it SHALL apply the entire validated patch atomically or return `400` without partial mutation.
4. WHEN usage is persisted THEN it SHALL retain the API-key identifier needed for aggregation without exposing the raw secret through public usage endpoints.
5. WHEN database export/import runs THEN it SHALL preserve policy configuration and counters using safe normalized representations.
6. WHERE logs, errors, metrics, or SSE events include API-key context THEN they SHALL use an internal key ID, configured display name, or existing masked representation and SHALL NOT expose raw key material.

### Requirement 8: Verification and regression protection

**User Story:** As a maintainer, I want focused tests for ACL behavior, so that later upstream merges or provider work cannot silently turn a shared key into unrestricted access.

#### Acceptance Criteria

1. WHEN schema migration tests run THEN fresh and existing databases SHALL produce unrestricted defaults for pre-existing keys and preserve policy values through export/import.
2. WHEN API-key repository and REST tests run THEN invalid policy values, empty policy defaults, create/update atomicity, expiry, and masking SHALL be covered.
3. WHEN gateway policy tests run THEN model, combo, alias, expired key, disabled key, daily quota, lifetime quota, preflight reservation, settlement, and concurrent reservation behavior SHALL be covered.
4. WHEN endpoint integration tests run THEN OpenAI, Anthropic, Responses, Ollama, Gemini native, embeddings, image, audio, search, fetch, and `/v1/models` visibility SHALL be covered according to the policy matrix.
5. WHEN UI tests run THEN create/edit policy submission, policy summaries, unlimited labels, expired state, and validation errors SHALL be covered.
6. WHEN all verification runs THEN no fixture, assertion failure, snapshot, log, or response SHALL expose a real API key or provider credential.
7. WHEN implementation completes THEN focused ACL tests, affected existing auth/usage/model-list tests, and the application build SHALL pass.
