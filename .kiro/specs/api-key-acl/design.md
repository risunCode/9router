# API Key ACL Design

## Overview

API Key ACL adds optional recipient policies to existing 9router keys. Policies limit visible and executable models/combos/aliases, enforce daily and lifetime token allocations, and expire automatically. Existing keys remain unrestricted because they have no ACL row.

The implementation reuses 9router's request translators, model resolver, API-key extraction, usage pipeline, Dashboard Endpoint page, and SQLite adapter. It does not create a parallel auth system, provider pool, or usage database.

### Decisions

1. **Dedicated normalized policy and ledger tables.** Do not overload `usageDaily` JSON or `_meta`; policy lookups and quota updates must remain indexed and transactional.
2. **Reserve before upstream I/O, settle from actual usage.** Reservations immediately count against the cap in the same SQLite transaction. This prevents parallel requests from over-allocating. Settlement replaces the reservation with actual usage and releases unused tokens.
3. **Fail conservatively for incomplete streams.** A request without reliable final usage keeps its reservation. A reaper only removes reservations that are provably stale after a bounded TTL.
4. **Exact policy identifiers.** An allowlist stores exact current request identifiers: provider-qualified models, combo names, or aliases. No wildcards in v1.
5. **Shared ACL service.** Handler code calls one shared policy entry point after parsing enough request data to identify the requested model, before provider selection. Model-list routes use the same policy resolver/filter.
6. **Static token accounting.** Daily limits use the server-local calendar date; lifetime limits never reset. This is understandable for bansos keys and works with free providers.

## Architecture

```mermaid
flowchart LR
  Client --> Guard[dashboardGuard trusted-route gate]
  Guard --> Handler[Existing v1/v1beta handler]
  Handler --> Extract[Extract key and requested model]
  Extract --> Policy[API-key ACL service]
  Policy --> Model[Existing alias/combo resolver]
  Policy --> Ledger[SQLite policy + reservation ledger]
  Policy -->|allow + reservation| Route[Existing provider routing]
  Route --> Stream[Existing stream/non-stream handler]
  Stream --> Settle[Usage settlement]
  Settle --> Ledger
  Policy -->|deny| Error[401 / 403 / 429]

  Dashboard --> KeyAPI[/api/keys]
  KeyAPI --> Ledger
  Dashboard --> KeyAPI
```

## Data model

### `apiKeyAcl`

One optional row per `apiKeys` record:

```sql
CREATE TABLE apiKeyAcl (
  keyId TEXT PRIMARY KEY REFERENCES apiKeys(id) ON DELETE CASCADE,
  allowedModels TEXT NOT NULL DEFAULT '[]',
  dailyTokenLimit INTEGER,
  lifetimeTokenLimit INTEGER,
  expiresAt TEXT,
  updatedAt TEXT NOT NULL
);
```

`[]`, `NULL`, or no row means unrestricted; `NULL`/zero caps mean unlimited; `NULL` expiry means non-expiring.

### `apiKeyQuotaUsage`

One row per key and server-local date, with committed and reserved counters:

```sql
CREATE TABLE apiKeyQuotaUsage (
  keyId TEXT NOT NULL REFERENCES apiKeys(id) ON DELETE CASCADE,
  dateKey TEXT NOT NULL,
  committedPromptTokens INTEGER NOT NULL DEFAULT 0,
  committedCompletionTokens INTEGER NOT NULL DEFAULT 0,
  reservedTokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (keyId, dateKey)
);
```

### `apiKeyLifetimeQuotaUsage`

```sql
CREATE TABLE apiKeyLifetimeQuotaUsage (
  keyId TEXT PRIMARY KEY REFERENCES apiKeys(id) ON DELETE CASCADE,
  committedPromptTokens INTEGER NOT NULL DEFAULT 0,
  committedCompletionTokens INTEGER NOT NULL DEFAULT 0,
  reservedTokens INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL
);
```

### `apiKeyQuotaReservations`

```sql
CREATE TABLE apiKeyQuotaReservations (
  id TEXT PRIMARY KEY,
  keyId TEXT NOT NULL REFERENCES apiKeys(id) ON DELETE CASCADE,
  dateKey TEXT NOT NULL,
  reservedTokens INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  endpoint TEXT,
  model TEXT
);
CREATE INDEX idx_akqr_key_expiry ON apiKeyQuotaReservations(keyId, expiresAt);
```

The reservation is a first-class durable record, rather than `_meta`, so cleanup and monitoring are indexed and auditable.

### Migration and compatibility

Migration version 2 adds the three tables and indexes. `SCHEMA_VERSION` increments and the schema table definitions mirror the migration. Existing keys receive no policy row and remain fully unrestricted. Database export/import includes ACL rows and committed quota counters, but excludes active reservations because they are ephemeral and must not survive an import.

## Policy service

New `src/sse/services/apiKeyPolicy.js` exposes pure and orchestration functions:

```js
resolveApiKeyPolicy(rawKey) -> { key, policy } | null
normalizeApiKeyPolicy(input) -> normalizedPolicy | validationError
checkModelAccess({ policy, requestedModel, aliases, combos }) -> allow | policyError
reserveApiKeyQuota({ keyId, policy, request, endpoint, model }) -> reservation | policyError
settleApiKeyQuota({ reservationId, usage, outcome }) -> void
reapExpiredApiKeyReservations(now) -> count
filterModelsByApiKeyPolicy(models, policy, resolutionContext) -> models
getApiKeyQuotaSummary(key) -> safeSummary
```

`resolveApiKeyPolicy()` checks active state and expiry. It never returns the raw key outside the service boundary. Policy errors are structured as `{ status, code, message, retryAfter? }` and rendered using existing OpenAI-compatible error helpers.

## Model semantics

Before credential selection, handlers pass the client-requested identifier into `checkModelAccess()`.

1. Exact allowlist match permits a provider-qualified model, combo name, or alias.
2. For aliases, the resolver uses existing `resolveModelAlias()` and checks both the explicit alias and its current resolved target.
3. Combo names are permitted as atomic routes. Members are not separately checked, preventing a normal combo fallback from failing after a valid user-level grant.
4. If a configured alias/combo no longer resolves, its request fails closed as `403 model_not_allowed`.
5. `/v1/models`, `/v1/models/{kind}`, model info, and Gemini model listing call `filterModelsByApiKeyPolicy()` after existing list construction. Empty policies return the original list.

`devin/swe-1-6-slow` is a normal exact identifier and therefore can be the sole bansos allowlist entry.

## Quota lifecycle

### Reservation

The policy service derives an estimate from the protocol body:

- output ceiling: `max_tokens`, `max_completion_tokens`, or protocol-equivalent;
- input: existing safe estimator where available;
- if input cannot be reliably estimated, reserve output ceiling only;
- no token-measurable endpoint reserves no token quota.

Inside one `adapter.transaction()` call:

1. Reap expired reservations for this key.
2. Reload the key/policy and recheck active/expiry.
3. Read committed plus reserved daily/lifetime usage.
4. Reject daily exhaustion with `429 token_quota_exceeded` and `Retry-After` until next local midnight.
5. Reject lifetime exhaustion with `429 token_quota_exceeded` without `Retry-After`.
6. Insert reservation row and increment `reservedTokens` in applicable daily and lifetime rows atomically.

Invariant:

```text
committed tokens + reserved tokens <= every enabled cap
```

Because both read and write occur inside the same SQLite transaction, parallel requests serialize and cannot each claim the same remaining allocation.

### Settlement

Stream and non-stream paths carry the `reservationId` through request context into existing `saveUsageStats()`.

Settlement runs in the same transaction as usage persistence where possible:

1. Load and delete the reservation.
2. Decrement daily/lifetime reserved counters.
3. Use actual canonical prompt + completion tokens if available.
4. If usage is missing after partial/error stream, charge the reservation estimate conservatively.
5. Increment committed daily/lifetime counters.
6. Persist normal `usageHistory`/`usageDaily` records once, preserving current dedup semantics.

For actual usage less than the reservation, unused capacity becomes immediately available. Actual usage greater than reservation is committed and may make a cap negative only by the bounded under-estimation of that single in-flight request; subsequent requests are blocked. The service logs a sanitized quota-overrun diagnostic.

A reservation TTL of ten minutes handles process crash or hard client disconnect. Reaping removes expired reservation rows and subtracts their still-held reserved counters atomically. No scheduled daemon is required: reserve and quota-summary calls trigger bounded cleanup.

## Enforcement coverage

`enforceApiKeyPolicy(requestContext)` is called after a handler extracts its model/provider but before `getProviderCredentials()` or upstream I/O.

| Surface | Requested identifier | Policy action |
| --- | --- | --- |
| OpenAI chat, Responses, Anthropic Messages, Ollama | body model | allowlist + quota reservation |
| Gemini native chat | native model path | allowlist + quota reservation |
| Embeddings, image, TTS, STT | body/form model | allowlist; reserve if token usage exists |
| Search/fetch | selected provider/model | key validity + allowlist; token quota only when measurable |
| `/v1/models`, kind list, info, Gemini list | catalog entries | filter with same policy resolver |
| token counting, voice metadata | no inference model | explicitly exempt from token reservation; retain existing auth policy |

The shared service is invoked by existing handler auth blocks rather than moving body-sensitive routes to generic Next middleware. `dashboardGuard` retains trusted loopback/CLI admin routing behavior but does not become a public ACL bypass. The Gemini native route adapts `x-goog-api-key`, Bearer, and query-key extraction into the same resolver.

## Dashboard and management API

The existing Endpoint/API Keys screen remains the owner of key management.

### REST

`POST /api/keys` accepts:

```json
{
  "name": "Bansos Devin A",
  "allowedModels": ["devin/swe-1-6-slow"],
  "dailyTokenLimit": 2000000,
  "lifetimeTokenLimit": 20000000,
  "expiresAt": "2026-08-01T00:00:00.000Z"
}
```

Only the creation response returns the new secret. GET/list responses contain the existing masked/display behavior plus:

```js
{
  policy: { allowedModels, dailyTokenLimit, lifetimeTokenLimit, expiresAt },
  quota: {
    state: "active" | "expired" | "disabled",
    daily: { used, reserved, limit, remaining, resetAt },
    lifetime: { used, reserved, limit, remaining },
  }
}
```

`PUT /api/keys/[id]` validates a complete patch before starting its transaction; invalid input changes nothing.

### UI

`EndpointPageClient` gains one policy form state used by both create and edit modals. It reuses `Input`, `Modal`, `Toggle`, and `ModelSelectModal` through a small multi-select wrapper—not a second model catalog.

The key row displays:

- active / expired / paused badge;
- exact model/combo count or “All models”;
- daily and lifetime `QuotaProgressBar` values, including unlimited labels;
- expiry date or “No expiry”;
- edit control separate from pause/delete/copy.

The form preserves entered values when the API returns validation errors. Full secrets remain copyable only under current visibility rules and never appear in usage summaries.

## Security and observability

- Raw key values are accepted only at auth extraction and key creation; policy, logs, quota tables, and public usage APIs use key IDs.
- API key attribution in `usageHistory` is migrated to `apiKeyId` or an existing masked representation; public usage APIs never return raw values.
- Error messages are generic: `API key expired`, `Model is not allowed for this API key`, `Token quota exceeded`.
- No ACL policy can modify provider connection credentials, rotation, account locks, or fallback behavior.

## File plan

```text
src/lib/db/schema.js
src/lib/db/migrations/002-api-key-acl.js
src/lib/db/migrations/index.js
src/lib/db/repos/apiKeysRepo.js
src/lib/db/repos/apiKeyAclRepo.js                 # new
src/lib/db/repos/quotaRepo.js                     # new
src/lib/db/repos/usageRepo.js
src/lib/db/index.js
src/lib/localDb.js
src/sse/services/apiKeyPolicy.js                  # new
src/sse/services/auth.js
src/sse/handlers/{chat,embeddings,imageGeneration,tts,stt,search,fetch}.js
src/app/api/v1/models/{route.js,[kind]/route.js,info/route.js}
src/app/api/v1beta/models/{route.js,[...path]/route.js}
src/app/api/keys/{route.js,[id]/route.js}
src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js
src/shared/components/ApiKeyModelMultiSelectField.js # new
```

## Testing strategy

1. **Repository/migration:** unrestricted legacy keys, invalid policy rollback, export/import, expiry.
2. **Ledger:** daily/lifetime reservation, actual settlement, interrupted-stream conservative settlement, stale reaping, and concurrent reservation attempts.
3. **Policy service:** exact model, combo, alias, stale alias, empty allowlist, model filtering, safe error contract.
4. **Endpoint integrations:** OpenAI, Responses, Anthropic, Ollama, Gemini native, embeddings, image, TTS, STT, search, fetch, models and model metadata.
5. **Dashboard/API:** form payload, field errors, quota summaries, unlimited display, expired badge, no secret leaks.
6. **Regression:** existing auth/model/usage tests plus application build.

All fixtures use fake API keys and fake provider credentials. No real session token is allowed in tests or snapshots.
