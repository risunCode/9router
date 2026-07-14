# 9router Customization Guide

## Multi Brain startup
Before meaningful work, read `.multibrain/session.md`, then selectively open the relevant bucket under `.multibrain/indexes/`. After material provider work, append a concise index entry and place detailed handoff notes under `.multibrain/context/`.

This fork tracks `decolua/9router` while carrying local provider integrations. Keep this document current whenever a custom provider, dependency, test contract, or upstream merge rule changes.

## Repository topology

| Remote | Purpose |
| --- | --- |
| `origin` | This fork: `https://github.com/risunCode/9router.git` |
| `upstream` | Source project: `https://github.com/decolua/9router.git` |

Work is performed on `master`. Do not commit credentials, generated runtime data, or local configuration.

### Local-only paths

These paths belong to the local deployment and must remain untracked during development and upstream merges:

```text
public/config/
public/configs.html
```

Never use a broad `git add .` while either path is present. Stage only the intended files.

## Custom provider: Devin

The Devin provider is a native Codeium/Devin Connect-protobuf integration. It does **not** use the Devin CLI, `account.toml`, a file watcher, a standalone DevinRouter process, or a second account pool.

### User-facing contract

- Provider ID and alias: `devin`
- Credential: one Devin session token stored through the standard API-key connection form.
- A raw JWT is accepted; the executor adds exactly one `devin-session-token$` prefix.
- Canonical model: `swe-1-6-slow`
- Capabilities: image input, tools, and reasoning; 200K context window and 64K maximum output.
- Live model discovery is intentionally deferred. The static model is always available; do not add a discovery path that selects credentials independently from the regular request flow.

A token pasted into source code, tests, fixtures, snapshots, logs, issue text, or documentation is a security incident. Use fake tokens in tests and rotate an exposed real token.

### Ownership map

| Concern | Files | Rule |
| --- | --- | --- |
| Provider metadata | `open-sse/providers/registry/devin.js` | Registry is the source of truth for Devin identity, form mode, model, and icon. |
| Registry aggregation | `open-sse/providers/registry/index.js` | Auto-generated static import list; regenerate it rather than manually inventing a second order. |
| Model capabilities | `open-sse/providers/capabilities.js` | Keep the exact `swe-1-6-slow` capability entry. |
| Executor registration | `open-sse/executors/index.js` | `DevinExecutor` must be imported, instantiated, and re-exported. |
| Executor entry point | `open-sse/executors/devin.js` | Owns one selected credential only; never selects/retries another account. |
| Protocol/auth/framing | `open-sse/executors/devin/protocol.js` | Connect framing, gzip, auth exchange, token normalization, safe frame cap. |
| Request translation | `open-sse/executors/devin/request.js` | Canonical OpenAI body to protobuf: text, images, tools, assistant tool calls, and tool results. Reuse 9router image helpers. |
| Response translation | `open-sse/executors/devin/response.js` | Protobuf frames to canonical OpenAI SSE. Preserve tool-call IDs/indexes, active tool-call continuation, reasoning, usage, finish reason, and `[DONE]`. |
| Error classification | `open-sse/executors/devin/errors.js` | Shared HTTP/trailer classifier and credential sanitization. |
| Generated bindings | `open-sse/executors/devin/proto/` | Generated code. Do not hand-edit. Replace the dependency closure atomically from the verified source when the upstream protobuf schema changes. |
| Icon | `public/providers/devin.png` | Devin visual identity sourced from OmniRouter's Lobe `Devin` icon reference; do not substitute Cursor, Windsurf, or a terminal icon. |
| Tests | `tests/unit/devin-*.test.js` | All credentials and upstream I/O must be fake/mocked. |
| Specification | `.kiro/specs/devin-provider/` | Requirements, design, and verified task history. Update it with material design changes. |

### Tool-call streaming contract

Devin tool calls are provider-native streamed deltas. 9router's job is to translate those deltas into OpenAI-compatible SSE; it must not execute tools server-side.

- Request translation must send OpenAI `tools`, assistant `tool_calls`, and `role: "tool"` results into Devin `ChatToolDefinition`, `ChatToolCall`, and `ChatMessageSource.TOOL` frames.
- Response translation must preserve a stable OpenAI `tool_calls[index]` for each Devin tool call ID.
- Devin may stream argument-only deltas with an empty `name` and sometimes an empty/missing `id`. Treat those as continuations of the last active tool call, matching the OMP direct-API pattern `tc.id || activeToolCallId`.
- Devin may stream either incremental argument chunks or full accumulated JSON prefixes. Track per-tool partial JSON and emit only the new suffix to OpenAI clients; never duplicate already-emitted argument bytes.
- Reject only a brand-new tool call that has neither a known/active ID nor a non-empty function name. Do not forward `function.name: ""` for a new OpenAI tool call.
- A client-side tool executor is responsible for applying streamed tool calls to a workspace. The hosted 9router API only emits the tool call stream.

### Vision boundary

Devin registry metadata may advertise vision support for client capability discovery, but current hosted testing established a practical upstream boundary: `devin/swe-1-6-slow` accepts image payloads through 9router without throwing `Unsupported or unsafe Devin image input`, yet the Devin/SWE runtime does not appear to read the attached `ChatMessagePrompt.images` content. Do not keep chasing this as a 9router translator bug unless a verified Codeium/Devin direct-API request proves the same model can actually see images.

Confirmed payload behavior:

- OpenAI/Codex chat-completions shape (`type: "image_url"` with `data:image/png;base64,...`) is accepted by 9router.
- OMP internal direct shape (`type: "image"`, `mimeType`, `data`) is accepted by 9router.
- Invalid/unsafe image inputs are client errors (`400`) and must not trigger Devin account fallback or locks.
- `kimchi/minimax-m3` successfully OCR'd the same screenshot via base64 data URI (`/completions`), proving the image payload and hosted route are valid.
- Devin responded as if no image was attached for that same payload; treat this as an upstream/model capability boundary until proven otherwise.

### Reference implementation boundaries

Use `DevinRouter/z-references/oh-my-pi-main/packages/ai/src/providers/devin.ts` as the closest direct API contract for Devin streaming, prompt replay, and tool-call delta accumulation. Do **not** copy OmniRoute's Devin CLI/ACP subprocess path: `devin acp` summarizer mode is pure-text and intentionally does not represent the 9router Devin integration.

### Error and failover policy

9router's existing account selector and `accountFallback` own rotation, cooldowns, and retry bounds. The Devin executor must never create a pool or disable a connection permanently.

| Upstream condition | Required behavior |
| --- | --- |
| Explicit temporary account/message rate limit | Eligible for existing pre-output account fallback/cooldown. |
| Explicit quota, usage-limit, or credit exhaustion | Eligible for existing longer account/model cooldown; not permanent deletion. |
| Generic HTTP 429, model capacity, overload, resource exhaustion | Not definitive quota. Preserve the distinction. |
| 401/403 authentication failure | Follow native refresh/fallback policy; do not permanently delete a connection after one failure. |
| Invalid model/request | Client error; do not rotate through every Devin connection. |
| Failure after text, reasoning, or tool output | Do not replay the request on another account. `valuableOutput` must remain true on the surfaced error. |

### Generated protobuf update procedure

The current generated binding source is the verified `DevinRouter` implementation. If Devin changes its protobuf schema:

1. Obtain the updated generated binding dependency closure from a verified source; never regenerate from an unknown schema or edit generated definitions by hand.
2. Replace `open-sse/executors/devin/proto/` atomically.
3. Ensure relative generated imports have Node-compatible `.js` extensions.
4. Remove stale source-map directives if the TypeScript source maps are not copied.
5. Run focused Devin tests and the production build before merging.

## API-key ACL (shared/bansos keys)

API-key ACL is opt-in. A legacy key without an `apiKeyAcl` row remains active, unrestricted, non-expiring, and quota-unlimited.

### Policy contract

```json
{
  "allowedModels": ["devin/swe-1-6-slow"],
  "dailyTokenLimit": 2000000,
  "lifetimeTokenLimit": 20000000,
  "expiresAt": "2026-08-01T00:00:00.000Z"
}
```

- Empty `allowedModels` means all otherwise available models.
- Zero/absent limits mean unlimited; absent `expiresAt` means no expiry.
- Model identifiers are exact and case-sensitive. Allowed aliases resolve to their current target; allowed combo names permit the combo's internal fallback members.
- A disabled or expired key is denied before upstream selection (`401`). A denied model is `403 model_not_allowed`. Daily/lifetime exhaustion is `429 token_quota_exceeded`; daily responses include `Retry-After`.
- `/v1/models`, kind/info routes, and Gemini discovery are filtered to the key's allowlist.

### Data ownership and quota invariant

| Data | Owner |
| --- | --- |
| Policy | `apiKeyAcl` / `apiKeyAclRepo.js` |
| Daily committed + reserved tokens | `apiKeyQuotaUsage` |
| Lifetime committed + reserved tokens | `apiKeyLifetimeQuotaUsage` |
| In-flight reservations | `apiKeyQuotaReservations` |
| Shared enforcement | `src/sse/services/apiKeyPolicy.js` |

Reservations are created before provider selection and increment reserved counters in the same SQLite transaction. Settlement records actual usage and releases unused reservation capacity. Never replace this with a non-atomic "check then increment" flow. Incomplete streams are charged their reservation conservatively; stale reservations have a bounded lazy cleanup TTL.

Dashboard key create/update uses top-level fields (`allowedModels`, `dailyTokenLimit`, `lifetimeTokenLimit`, `expiresAt`); GET/list returns nested `policy` and `quota` summaries. The raw key is creation-only and must never be added to policy/usage output.

### ACL verification

```bash
npx vitest run --config tests/vitest.config.js \
  tests/unit/api-key-acl.test.js \
  tests/unit/api-key-acl-model-routes.test.js \
  tests/unit/api-key-acl-media-handlers.test.js \
  tests/unit/api-key-acl-special-handlers.test.js \
  tests/unit/gemini-native-endpoint.test.js
npm run build
```

On Windows, the existing generic DB concurrency test may fail cleanup with `EPERM` on its temporary SQLite directory. Treat it as an environment/harness diagnosis unless a focused ACL reservation test fails; do not weaken atomic ledger behavior to make that cleanup race disappear.

## Safe upstream update procedure

Use this procedure after custom work is committed or intentionally stashed. Never merge upstream over an unknown dirty working tree.

### 1. Inspect local state

```bash
git status --short
git fetch upstream --prune
git log --oneline --left-right master...upstream/master
```

Confirm that only intended custom changes are present. Leave `public/config/` and `public/configs.html` untracked.

### 2. Merge upstream

```bash
git merge --no-edit upstream/master
```

Use a merge commit rather than rewriting published `master` history.

### 3. Resolve conflicts by ownership

- **Upstream-owned generic files** (`chatCore`, translators, account fallback, schema): start from upstream and reapply only required custom behavior. Do not preserve a forked copy merely to avoid conflict resolution.
- **Custom Devin files** (`registry/devin.js`, `executors/devin.js`, `executors/devin/**`, Devin tests, icon, Kiro spec): keep the custom implementation, then adapt it to upstream interfaces.
- **Shared registries** (`registry/index.js`, `executors/index.js`, `capabilities.js`): retain upstream entries and reinsert exactly the Devin registration/capability. Do not drop new upstream providers.
- **`package.json` / lockfile**: preserve upstream dependency upgrades, then retain `@bufbuild/protobuf`, `chalk`, and `prop-types` when they are still required by imports. Regenerate the lockfile with npm; do not manually resolve lockfile internals.
- **Baseline snapshots**: regenerate only after the merged runtime provider set is deliberate. They include upstream provider changes as well as custom Devin changes.

### 4. Regenerate derived registry baselines

Run these only after the merged registry is final:

```bash
node tests/__baseline__/snapshot-providers.mjs
node tests/__baseline__/verify-alias.mjs --snapshot
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
```

The first two commands intentionally rewrite snapshots. Review their diff: expected upstream providers and Devin must be present; no provider must disappear accidentally.

### 5. Verify custom behavior and the merged application

```bash
npx vitest run \
  tests/unit/devin-errors.test.js \
  tests/unit/devin-protocol.test.js \
  tests/unit/devin-integration.test.js \
  tests/unit/api-key-acl-model-routes.test.js

npx vitest run \
  tests/unit/modality-strip.test.js \
  tests/translator/format-roundtrip.test.js \
  tests/translator/golden-response-stream.test.js

npm run build
```

On Windows, if Next scans protected user-profile junctions, isolate `HOME` and `USERPROFILE` to the repository for the build command. Do not accept a build failure caused by missing dependencies: restore declared dependencies first, then rerun the build.

### 6. Review before push

```bash
git status --short
git diff --check
git diff -- public/config public/configs.html
```

The final diff must not contain real tokens, exchanged JWTs, authorization headers, cookies, or local configuration. Commit the merge and verified custom adaptations, then push `master` to `origin`.

## Change discipline

1. Read the relevant provider registry, executor, and focused tests before editing.
2. Reuse 9router's generic OpenAI/Anthropic, multimodal, tool, account, proxy, and streaming infrastructure. Add provider-specific code only at the actual Devin protocol boundary.
3. Test observable protocol and conversion behavior, not source text.
4. For exported/cross-file symbols, use language-server references when available before changing behavior.
5. Run focused tests first, then provider baselines, then `npm run build`.
6. Update `.kiro/specs/devin-provider/` when changing the approved contract or architecture.
