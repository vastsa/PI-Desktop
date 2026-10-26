# Plugin provider API reference

Extend **Add AI service** with reusable integration templates; let PI-Desktop
own accounts, credentials, model settings and native model execution.

> **Status:** describes the current `feat/plugin-model-providers` implementation,
> not a published SDK compatibility guarantee. V1 templates/adapters are implemented;
> real Antigravity interoperability is not certified. The prior candidate's full
> Host suite still had 18 failures; see [validation](spec/06-delivery/provider-template-validation.md).
> Plugins are trusted Node code, **not an OS sandbox**. Standard declarations do
> not hand credentials to callbacks; custom OAuth/inference needs separate grants.

## 1. Choose the integration surface

| Task | Surface | Required grants |
| --- | --- | --- |
| Add a compatible API-key or no-auth service | `contributes.providerTemplates` | `provider.register` |
| Use public-client PKCE or device OAuth | Template `oauth` declaration, executed by Host | `provider.register` |
| Implement proprietary OAuth | Export `onProviderOAuth` | Also `provider.oauth` |
| Implement proprietary chat/images | Export `providerAdapters[templateId]` | Also `provider.inference` |
| Create/edit/delete accounts | Native application UI and internal IPC/RPC | Not a plugin SDK account-management API |

Custom callbacks using `pi.net.fetch` additionally need `net.fetch` and declared
`net.domains`. Raw Node I/O is outside that Host API enforcement, which is why
custom execution is a trust decision. Permission names do not grant access until
the Host has approved them.

### Identity rules

| Value | Example | Meaning |
| --- | --- | --- |
| Plugin ID | `example.gateway` | Manifest package identity |
| Template ID | `gateway` | Plugin-local reusable declaration |
| Chooser key | `plugin-template:example.gateway:gateway` | Directory entry; never a saved provider row |
| Account ID | Host-generated UUID | Independent native provider, secret/cache/preferences owner |
| Legacy row ID | `plugin:example.gateway:gateway` | Existing singleton `contributes.providers` only |

In OAuth and inference callback requests, **`providerId` is the local contribution
ID**, not the account UUID. Custom OAuth additionally receives `accountId` for
template accounts. Inference callback context has no `accountId` field: the Host
binds the account internally and supplies only that request's credentials.

## 2. Add a compatible service

Save this as the plugin's `manifest.json`, and the following module as `main.cjs`.
The reserved `.test` address is illustrative, not a working vendor endpoint.
Replace it only with an endpoint you are authorized to use. Installing this
plugin adds an entry; it does not allocate an account or make a model request.

```json
{
  "schemaVersion": 1,
  "id": "example.gateway",
  "name": "Example Gateway",
  "version": "1.0.0",
  "main": "main.cjs",
  "permissions": ["provider.register"],
  "contributes": {
    "providerTemplates": [{
      "version": 1,
      "id": "gateway",
      "name": "Example compatible service",
      "category": { "en": "Community services", "zh-CN": "社区服务" },
      "authKind": "api_key",
      "baseUrl": "https://api.example.test/v1",
      "apiStyle": "chat_completions",
      "models": [{ "id": "example-chat", "contextWindow": 128000, "maxTokens": 8192 }]
    }]
  }
}
```

```js
module.exports = {};
```

The user selects the entry, enters a key in the native form, then saves an
independent account. Selecting the same entry again creates another account.
For no-auth, use `authKind: "none"` and a nonempty model list. Neither path needs
an OAuth hook or custom adapter. If API-key `models` is empty, `baseUrl` is
required and Host discovery supplies model choices after key setup. Discovery
failure keeps the saved account for retry, rather than creating a duplicate.

### Template fields

`PluginProviderTemplateV1` is a closed object. Unknown fields, ownership fields
and secret references are rejected. String limits below count UTF-16 units;
nonempty strings cannot contain control characters.

| Field | Type / required | Rules or default |
| --- | --- | --- |
| `version` | `1`, required | Template schema version, not plugin package version |
| `id` | `string`, required | `[a-zA-Z][a-zA-Z0-9_-]{0,63}`; unique across both provider arrays |
| `name` | `string`, required | At most 128 |
| `category` | string or `{en, "zh-CN"}` | Each label at most 128; defaults to plugin name |
| `description` | string or `{en, "zh-CN"}` | Each label at most 280; chooser hover/focus text |
| `vendorKey` | `string` | At most 128; defaults to `custom`; does not select an official OAuth implementation |
| `baseUrl` | `string` | Absolute HTTP(S), at most 2048; required for OAuth/empty-model discovery |
| `apiStyle` | enum | Defaults to `chat_completions`; see below |
| `authKind` | `"api_key" \| "none" \| "oauth"` | Defaults to `api_key` |
| `oauth` | OAuth object | Only for `authKind: "oauth"`; omission means custom flow |
| `adapter` | `{version: 1, chat?: boolean, images?: boolean}` | At least one true; requires custom inference grant/export |
| `models` | model array, required | At most 64; empty only for API-key + `baseUrl` |

URLs reject userinfo, fragments, whitespace and backslashes. Declaration syntax
does not bypass existing Host endpoint/DNS/proxy policy. Use lowercase `http` or
`https` schemes for compatibility with shared validation. Localized objects
accept exactly `en` and `zh-CN`, not an arbitrary locale dictionary.

Supported `apiStyle` values: `chat_completions`, `opencode_go`, `responses`,
`anthropic_messages`, `google_generative_ai`, `openai_codex_responses`,
`pi_messages`. `auto` and `openai` are not valid manifest style values.

### Model fields

| Field | Type | Rules |
| --- | --- | --- |
| `id` | required string | 1..256; unique after trimming; wire identity |
| `name` | string | At most 128; defaults to ID |
| `contextWindow`, `maxTokens` | number | Positive uint32 integers; omit for runtime defaults |
| `supportsImages` | boolean | Image **input**, not image generation |
| `thinkingLevels` | string array | At most 16 entries, each at most 64; Host normalizes canonical levels |
| `defaultThinkingLevel` | string | At most 64; used only when present in normalized levels |
| `operations` | `("chat" \| "images")[]` | Adapter-only, nonempty, cannot exceed adapter operations; omit to inherit |

Native account editing owns aliases, selected models, limits, delegation opt-in
and enablement. These user preferences are not extra template fields. Explicit
empty account model selection persists; a manifest refresh does not repopulate it.
Image-only adapter models cannot become chat defaults or subagent chat models.
Use canonical integer JSON encoding (`8192`, not `8192.0` or exponent notation)
for manifest numeric fields because the Rust reader expects integer encoding.

## 3. Configure Host-run OAuth

Replace the template in the compatible example with the following template.
Keep `permissions: ["provider.register"]` and the empty module. These endpoints,
client IDs and scopes are synthetic; register real public-client details with
the vendor before attempting a live integration.

```json
{
  "version": 1,
  "id": "oauth_gateway",
  "name": "Example public-client OAuth",
  "authKind": "oauth",
  "baseUrl": "https://api.example.test/v1",
  "apiStyle": "chat_completions",
  "oauth": {
    "flow": "authorization_code",
    "clientId": "example-public-client",
    "authorizationUrl": "https://auth.example.test/authorize",
    "tokenUrl": "https://auth.example.test/token",
    "scopes": ["openid", "inference"],
    "redirectPath": "/callback"
  },
  "models": [{ "id": "example-chat" }]
}
```

| OAuth field | Authorization code | Device code | Custom / omitted flow |
| --- | --- | --- | --- |
| `flow` | `authorization_code` | `device_code` | `custom` or absent |
| `clientId` | Required, at most 512 | Required, at most 512 | Forbidden |
| `tokenUrl` | Required HTTPS | Required HTTPS | Forbidden |
| `authorizationUrl` | Required HTTPS | Forbidden | Forbidden |
| `deviceAuthorizationUrl` | Forbidden | Required HTTPS | Forbidden |
| `scopes` | Optional | Optional | Forbidden |
| `redirectPath` | Optional; `/callback` default | Forbidden | Forbidden |
| `loginLabel`, `isSubscription` | Optional display metadata | Optional display metadata | Optional display metadata |

For device OAuth, change `flow` to `device_code`, remove `authorizationUrl` and
`redirectPath`, and add `deviceAuthorizationUrl`. All OAuth URLs use the URL
bounds above and HTTPS. Scopes are at most 64 unique RFC 6749 ASCII scope tokens,
each 1..256 characters. Callback paths are at most 256 characters, start with one
slash (not `//`), and contain only ASCII letters/digits, `/`, `_`, `-`.

Host handles PKCE S256, random state, ephemeral IPv4 loopback callback, token
exchange and encrypted persistence. Device polling handles pending/slow-down,
expiry and cancellation. Standard token mapping is fixed: `access_token`,
`refresh_token`, `expires_in`. No client secret, arbitrary field expression,
JWT account inference or server-header mapping is supported. Engine defaults
are five minutes overall (ceiling ten) and thirty seconds per network request;
these are Host settings/test seams, not template fields.
The callback listener rejects invalid state or malformed/duplicate code/error
parameters without consuming the login. A later valid callback can complete
within the original timeout; a valid state-bound denial ends login without
token exchange.

## 4. Implement custom OAuth when necessary

Declare `authKind: "oauth"`, a `baseUrl`, nonempty models and optionally
`oauth: {flow: "custom"}`. Request both `provider.register` and `provider.oauth`.
Export this signature from the plugin module:

```ts
import type {
  PluginProviderOAuthRequest,
  PluginProviderOAuthContext,
  PluginProviderOAuthCredential,
} from "@pi-desktop/plugin-sdk";

type OAuthHandler = (
  request: PluginProviderOAuthRequest,
  context: PluginProviderOAuthContext,
) => Promise<PluginProviderOAuthCredential> | PluginProviderOAuthCredential;
```

| Request field | Meaning |
| --- | --- |
| `operation` | `login` or `refresh` |
| `providerId` | Local contribution/template ID |
| `accountId?` | Host-selected account UUID for template accounts; absent on legacy singleton requests |
| `loginId?` | Login interaction ID; use for prompt/notify, not persistence |
| `credential?` | Current account credential during refresh only |

`context.signal` is aborted on cancellation/unload/timeout. Honor it, close
resources and do not persist tokens yourself. Return the credential to Host:

| Credential field | Type / semantics |
| --- | --- |
| `accessToken` | Required nonempty string |
| `refreshToken?` | Secret refresh token; omitted refresh result retains prior value |
| `expiresAt?` | Unix epoch **milliseconds**, not seconds; omit for nonexpiring access |
| `accountLabel?` | Non-secret label; never put tokens here |
| `headers?` | Request headers carried with this credential |
| `requestData?` | Encrypted JSON-only routing object; at most 16 KiB UTF-8, depth at most 64 |

Omitted refresh `requestData` preserves previous routing; `{}` explicitly clears
it. Only authorized inference callbacks receive routing metadata. Refresh tokens
stay in the OAuth callback/Host secret path, never inference, Renderer or Agent
launch data. Omitted optional account label/headers are retained on refresh.

Use `pi.providers.oauth.prompt(loginId, input): Promise<string>` for a native
question. `input` is `{type, message, placeholder?, options?}`; type is `text`,
`secret`, `select` or `manual_code`. Select options are
`{id, label, description?}[]`. Cancellation rejects the pending interaction.

Use `pi.providers.oauth.notify(loginId, event): Promise<void>` for **non-secret**
progress. Event kinds are `info`, `authUrl`, `deviceCode`, `progress`; fields
match their names in the native event table below. Do not send credentials in
messages, URLs, labels, progress or logs. Notification/prompt text is rendered
as user-facing content, not a secret channel. A callback is not a safe way to
execute untrusted vendor code.

## 5. Implement a custom inference adapter

The following complete template pairs with the module below. Add it under
`contributes.providerTemplates`, grant `provider.register` and
`provider.inference`, and use `main.cjs`. This **synthetic fixture** performs no
network or paid generation; it demonstrates the executable contract only.

```json
{
  "version": 1,
  "id": "fixture",
  "name": "Synthetic chat and image adapter",
  "authKind": "none",
  "adapter": { "version": 1, "chat": true, "images": true },
  "models": [
    { "id": "fixture-chat", "operations": ["chat"] },
    { "id": "fixture-image", "operations": ["images"] }
  ]
}
```

```js
module.exports = {
  providerAdapters: {
    fixture: {
      version: 1,
      async *chat(request, context) {
        context.signal.throwIfAborted();
        yield { type: "text", delta: "Synthetic adapter response" };
        yield { type: "done", stopReason: "stop", usage: { input: 0, output: 0 } };
      },
      async images(request, context) {
        context.signal.throwIfAborted();
        return {
          images: [{
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII="
          }]
        };
      }
    }
  }
};
```

The export key must equal the contribution ID, not a chooser/account ID.
`chat(request, context)` returns an `AsyncIterable` (or a promise of one);
`images(request, context)` returns a promise of the image result.

### Requests and credentials

| Input | Shape |
| --- | --- |
| Chat request | `{version: 1, providerId, modelId, messages, options?}` |
| Chat options | `{maxTokens?: number, temperature?: number, reasoning?: string}` |
| Image request | `{version: 1, providerId, modelId, input}` |
| Image input | Array of `{type: "text", text}` or image objects |
| Context | `{signal: AbortSignal, credential?}` |
| Credential | `{apiKey?: string, headers?: Record<string,string>, requestData?: JsonObject}`; **never refreshToken** |

Messages use roles `system`, `user`, `assistant`, `toolResult`. Content is a
string or typed text/thinking/image/tool-call blocks. Tool results carry
`toolCallId`, `toolName`, `isError`; system messages may carry `sections`,
`toolsAdded`, `toolsRemoved`. Preserve order and replay signatures/metadata:
flattening everything into user text breaks tool continuation and signed reasoning.
Use SDK `PluginProviderMessageV1` / `PluginProviderContentV1` for exact types.

### Chat events

| `type` | Fields |
| --- | --- |
| `text` | `delta: string`, optional `signature` |
| `thinking` | `delta: string`, optional `signature`, `redacted` |
| `toolCall` | `id`, `name`, object `arguments`; optional `thoughtSignature`, `namespace`, `argumentsError` |
| `done` | `stopReason: "stop" \| "length" \| "toolUse"`, **required** `usage`; optional `responseId` |
| `error` | `message: string`; Host replaces the message with safe fixed text |

Usage is `{input: number, output: number, cacheRead?: number, cacheWrite?: number}`
with finite nonnegative counts. Emit a terminal event; do not replace `usage`
with provider-specific keys. Tool calls contain parsed JSON objects, not JSON
strings. The adapter requests tools; native Host/Agent authorizes and executes
them, then re-enters the model with results. Adapters do not execute Agent tools.

### Images and bounds

Result: `{images: Image[], usage?}`. Each image is
`{type: "image", mimeType, data}`, where data is validated base64, not a URL,
data URL or local path. MIME types: PNG, JPEG, WebP, GIF. Native image tooling
writes validated output to Host scratch storage; return no arbitrary filesystem
paths. Receiving image input does not imply image-generation entitlement.

| Bound | Current value |
| --- | --- |
| JSON request | 16 MiB |
| Stream event | 256 KiB |
| Stream total / event count | 32 MiB / 32,768 |
| Decoded image / output count | 8 MiB / 1..4 |
| Broker active chat capacity | 16 |
| Invocation call / chat lifetime | 120 seconds / 10 minutes |

These are current `PLUGIN_INFERENCE_LIMITS`, not configurable manifest options.
Host checks account/template, session, model, grants and runtime generation.
Unload/revoke/delete cancels work and rejects late results. No automatic custom
retry or paid-provider fallback is added. A custom adapter connection test is
`UNSUPPORTED` when no safe non-billable probe exists; it does not generate images
or refresh a token merely to report success.

## 6. Internal native account API

**Audience: PI-Desktop application maintainers.** The following is not an HTTP
API, not a `pi.providers.create` SDK surface, and not permission for plugins to
read/write arbitrary accounts. Renderer invokes approved preload channels;
Main calls Rust JSON-RPC. Only Host derives ownership/secret references.

### Template-specific Host RPCs

| Method | Closed `params` | Result |
| --- | --- | --- |
| `providers.getTemplate` | `{pluginId, templateId}` | `{template: PluginProviderTemplateV1}` |
| `providers.createFromTemplate` | `{pluginId, templateId, name?, secretValue?}` | `{provider: ProviderPublic}` |
| `providers.completeTemplateOAuth` | `{id: accountId}` | `{provider: ProviderPublic}` |

Lookup/create requires installed, enabled and granted source metadata. `name`
is nonempty, at most 128 UTF-16 units. Optional API-key `secretValue` is nonempty,
no controls, at most 65,536 UTF-8 bytes; it is forbidden for OAuth/no-auth.
Unknown fields including `id`, `ownerPluginId`, `secretRef` are rejected on
creation. There is no caller-selected account UUID or bulk account adoption.

Create returns a ready key/no-auth row as appropriate; OAuth creates a disabled
pending row. Main stores validated OAuth credentials, then calls completion.
Completion requires a stored credential and revalidates current source metadata.
Do not expose lookup/completion as arbitrary Renderer or plugin calls.

JSON-RPC request example (synthetic key, account is created only if invoked):

```json
{
  "jsonrpc": "2.0",
  "id": "create-example-account",
  "method": "providers.createFromTemplate",
  "params": {
    "pluginId": "example.gateway",
    "templateId": "gateway",
    "name": "Personal gateway",
    "secretValue": "synthetic-example-key"
  }
}
```

Native Renderer create channel: `pi-desktop/providers/createFromTemplate`.
Existing account channels remain `pi-desktop/providers/update`, `/setSecret`,
`/delete`, `/listModels`, `/testConnection` under the same prefix. Use the
application API wrapper; direct Rust calls alone do not perform Main's runtime
binding invalidation or model-cache cleanup.

Relevant public provider fields: `id`, `name`, `enabled`, `authKind`, `baseUrl?`,
`models`, `hasSecret`, `hasOauth?`, `oauthAccountLabel?`, `ownerPluginId?`,
`pluginTemplateId?`, `pluginTemplateVersion?: 1`,
`pluginModelOperations?: Record<string, ("chat" | "images")[]>`.
Ownership/capability/source fields are read-only projections, not update inputs.
Tokens, refresh metadata and internal secret refs are not public provider fields.

### Native OAuth channels

All invoke paths below have prefix `pi-desktop/providers/oauth/`.

| Suffix | Input | Return / behavior |
| --- | --- | --- |
| `vendors` | None | `{vendors}` including template entries and account groups |
| `start` | String chooser key or native account ID | `{loginId}`; template key creates, account ID reauthenticates |
| `respond` | `{loginId, promptId, value?}` | `{ok: boolean}`; omitted value cancels |
| `cancel` | String login ID | `{ok: boolean}` |
| `delete` | String account ID | `{ok: true}` after account removal; legacy singleton signs out only |

Login progress is the existing `OAuthLoginEvent` contract. Every event includes
`loginId` and `vendorId`; `done.providerId` is the resulting **native account ID**.

| Event `kind` | Additional fields |
| --- | --- |
| `info` | `message`, optional `links: {url, label?}[]` |
| `authUrl` | `url`, `opened: boolean`, optional `instructions` |
| `deviceCode` | `userCode`, `verificationUri`, optional `intervalSeconds`, `expiresInSeconds` |
| `progress` | `message` |
| `prompt` | `request: {promptId, type, message, placeholder?, options?}` |
| `promptCancelled` | `promptId` |
| `done` | `providerId`, optional `accountLabel` |
| `error` | `message`, optional `code: "PLUGIN_OAUTH_FAILED"` |
| `cancelled` | None |

Wait for `done`, not merely a successful `start` response. New failed/cancelled
logins remove only their pending row/secrets; reauth does not allocate a third
row. Cleanup failures are observable and abandoned pending rows are retried at
startup. User enablement is distinct from plugin/source availability.

### Errors

Rust template RPC errors use the normal JSON-RPC error envelope with
`error.data.errorCode`. Do not parse human-readable messages for control flow.

| Boundary / code | Meaning and caller action |
| --- | --- |
| RPC `INVALID_PARAMS` (1002) | Wrong/unknown DTO fields; fix the request |
| RPC `PROVIDER_TEMPLATE_INVALID` (1002) | Invalid template identity, name/secret or account kind |
| RPC `PROVIDER_TEMPLATE_UNAVAILABLE` (1002) | Source/account missing, disabled or ungranted; reload native catalog |
| RPC `PROVIDER_TEMPLATE_OAUTH_REQUIRED` (1002) | Completion has no valid stored OAuth credential; authenticate again |
| RPC `INTERNAL` (1000) | Unexpected/unclassified failure; retain safe diagnostic context |
| Native login `PLUGIN_OAUTH_FAILED` | Safe login error; raw callback/server failure is not exposed |
| Runtime `PLUGIN_CALL_FAILED` | Safe custom inference failure; no automatic paid fallback |
| Runtime `PLUGIN_UNLOADED` / cancellation | Runtime/account binding became stale; stop consuming results |
| Native connection result `UNSUPPORTED` | `{ok: false, network: "skipped", errorCode: "UNSUPPORTED"}`; no safe probe |

Declarative engine `OAUTH_*` codes (config, state, network, expiry, invalid grant,
cancellation, etc.) are Main-internal diagnostics; they are **not** the native
login event's public `code` union. Raw exceptions and explicit adapter stream
errors are normalized. This does not make arbitrary plugin notifications, logs
or raw Node execution safe for secret material.

## 7. Lifecycle and compatibility

| Action | Account / secret behavior | Runtime behavior |
| --- | --- | --- |
| Disable plugin or revoke grants | Retain accounts, credentials and preferences | Reject new use; cancel source work |
| Remove a template from manifest | Keep account unavailable/removable | Restore only after valid same-source reconciliation |
| Delete one template account | Delete its secret, discovery and binding | Cancel only its work; keep peer accounts and directory entry |
| Uninstall plugin | Delete owned accounts, secrets, discovery and pending state | Cancel work; retain historical conversations |
| Change endpoint/auth/protocol/client/scopes/adapter | Invalidate old credentials/discovery | Require reconfiguration; never silently forward old secrets |
| Change display metadata | Preserve native user preferences | Reconcile defaults without replacing account identity |

Uninstall first commits every owned account as disabled with a Host-only cleanup
marker, then attempts all account/credential removals. Cleanup or registry-write
failure rejects the internal `plugins.uninstall` RPC with `INTERNAL` (1000) and a
safe retry diagnostic; it does not acknowledge successful erasure. Residual rows
cannot be re-enabled or OAuth-completed. Startup, repeated uninstall and same-ID
registration retry cleanup rather than adopting old grants. Once storage recovers,
template accounts require fresh explicit creation/login. If cleanup intent cannot
be committed, uninstall aborts before registry or secret mutation.

Schema25 stores validated versioned bindings in `provider_template_bindings`.
Official services do not migrate to templates. Legacy `contributes.providers`
keeps its singleton IDs, auth grants and deletion rules; installing/upgrading
must not convert those rows or duplicate credentials. See the
[lifecycle specification](spec/07-plugins/17-provider-template-accounts.md) and
[architecture decision](adr/plugin-provider-template-accounts.md).

## 8. Validate an integration without a real service

SDK `parseProviderTemplate(value)` returns
`{ok: true, template}` or `{ok: false, error}`. It validates shape/model rules;
it does not approve permissions, network access, credentials or vendor support.
Use `validateManifest(value)` as well to check the full manifest/grant declaration.

From the request worktree using existing dependencies:

```sh
pnpm --filter @pi-desktop/plugin-sdk exec vitest run src/provider-template.test.ts src/provider-adapter.test.ts
node --test apps/desktop/test/provider-template-*.test.mjs
cargo test -p host-core --locked provider_template
# Separate actual-Host fixture; requires a current debug Host build:
cargo build -p host-core --locked
node --test apps/desktop/test/provider-template-native-host.e2e.mjs
```

The SDK declarations are in `packages/plugin-sdk/src/index.ts`,
`provider-template.ts` and `provider-adapter.ts`; public native types are in
`packages/shared/src/types/providers.ts`. Rust source authority is
`crates/host-core/src/plugins/provider_templates.rs` and `rpc/mod.rs`.
These repository paths identify source files, not public runtime endpoints.
Existing [candidate evidence and limits](spec/06-delivery/provider-template-validation.md)
remain separate from this reference. Running synthetic fixtures does not prove
real vendor OAuth registration, proprietary protocol compatibility or entitlement.
