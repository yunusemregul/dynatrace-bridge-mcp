# Dynatrace Bridge MCP — Architecture and contracts

Binding contract for everyone working on this repo. `PLAN.md` says what to build and which Dynatrace endpoints exist; `INSPECTION.md` says how to inspect Dynatrace live. This file says how the pieces fit. The reference implementation to imitate is `~/Projects/kibana-mcp` (same author, same architecture).

## Identity

| | |
|---|---|
| npm package / MCP server name | `dynatrace-bridge-mcp` |
| Extension display name | `Dynatrace Bridge` |
| WebSocket port (server ⇄ extension) | `47831` (`WS_PORT`) |
| MCP HTTP port | `47832` (`MCP_PORT`) |
| Bind host | `127.0.0.1` (`HOST`) |
| Extension install dir | `~/.dynatrace-bridge/extension` |
| Extension id | `nnfgclefihmkappeocegckipegkalloe` (origin `chrome-extension://nnfgclefihmkappeocegckipegkalloe`), fixed by the public `key` in `extension/manifest.json`; the private key was discarded and exists nowhere |
| Handoff secret | `~/.dynatrace-bridge/handoff-secret` (mode 0600, created at first start) |
| Console prefix | `[Dynatrace Bridge]` (extension), `[MCP Server]` (server, stderr only) |
| Node | `>=18`, ESM (`"type": "module"`), no build step, no TypeScript |

## Layout

```
server.js                 entry: argv handling, install-extension, starts WS hub + MCP (stdio and HTTP, see Local HTTP endpoint), loads every lib/tools/*.js
install-extension.js      same behaviour as kibana-mcp's
lib/bridge.js             WebSocket hub (extension origin pinning, HELLO validation), request correlation, per-environment queue, dt() request helper, error types
lib/allowlist.js          read-only allow-list: GET routes and deny rules (same rules in extension/allowlist.js)
lib/updates.js            version comparison and the npm latest-release check (see Updates)
lib/time.js               timeframe arguments -> every format Dynatrace wants
lib/servicefilter.js      servicefilter encoder (PLAN.md 3.2)
lib/format.js             markdown output helpers: units, tables, series summaries, truncation, deep links
lib/tools/<group>.js      tool definitions, one file per group, auto-loaded
extension/                MV3 extension: manifest.json, background.js, content.js, inject.js, allowlist.js, popup.html, popup.js, badge.js, _locales/{en,tr}
scripts/verify.js         the build check (`npm run verify`), see Build check
scripts/allowlist-cases.js   table of `{ method, path, allowed }` cases both allow-list implementations must agree with
scripts/sync-extension-version.js
```

Ownership rule: a tool group owns exactly `lib/tools/<group>.js`. Shared files under `lib/*.js` are changed only by whoever owns the core; if a tool group needs a new shared helper it keeps it local to its own file and reports it.

## WebSocket protocol (server ⇄ extension background)

JSON text frames. The server accepts a connection only when its `Origin` header is exactly the origin of the shipped extension, `chrome-extension://nnfgclefihmkappeocegckipegkalloe` (derived at startup from the `key` in `extension/manifest.json`), or one of the origins listed in the environment variable `DT_BRIDGE_EXTENSION_ORIGINS` (comma- or space-separated, e.g. `chrome-extension://<id>` of a fork or of a build with another key, or `moz-extension://<uuid>`). Everything else is refused during the handshake, including clients that send no `Origin`; a web page cannot forge the header, and each refused origin is logged once. When an extension with another id was refused in the last minute, the `NO_EXTENSION` error says so and tells the user to reinstall the extension.

Accepted limitation: the extension connects to whatever listens on `ws://localhost:<port>`, so another local user or process that binds the WebSocket port before the server does receives the extension's connection and can send it allow-listed (read-only) requests. Closing that would need a pairing secret between server and extension, which this project deliberately does not have; the same holds for a process that binds the MCP port first and answers `/health` as this package.

Extension → server:

```jsonc
{ "type": "HELLO", "version": "1.0.0",
  "environments": [ { "name": "s1", "envId": "abc12345", "origin": "https://dynatrace.example.com", "basePath": "/e/abc12345" } ] }
{ "type": "PING" }
{ "type": "DT_RESULT", "requestId": "…", "status": 200, "data": <parsed JSON or string>, "polls": 3 }
{ "type": "DT_RESULT", "requestId": "…", "error": "message", "errorCode": "SESSION_EXPIRED", "status": 401, "loginTab": "opened" }
```

`HELLO` is sent on connect and again whenever the environment list changes. `loginTab` is only present on `SESSION_EXPIRED`: `"opened"` when the extension has just opened a tab that landed on a login page, `"waiting"` when that tab is still on a login page on a later request.

The server validates every `HELLO` and keeps only what passes; the extension applies the same rules before it stores or sends an environment. `name`: 1 to 64 characters, letters, digits, space, `.`, `_`, `-`, starting with a letter or digit, unique per connection (case-insensitive). `origin`: an `http:` or `https:` origin in canonical form (no path, no user info). `basePath`: `/e/<id>` with `<id>` made of letters, digits, `.`, `_`, `-`. `envId` is not trusted: the server takes it from `basePath`. `version` must be `major.minor.patch`, otherwise the version counts as unknown. At most 50 environments per connection. Because of these rules the names, URLs and versions that end up in tool descriptions, error messages and logs cannot carry markup, line breaks or instructions.

Server → extension:

```jsonc
{ "type": "PONG" }
{ "type": "WELCOME", "serverVersion": "1.0.0", "latestVersion": "1.1.0" | null }
{ "type": "DT_REQUEST", "requestId": "…", "environment": "s1" | null, "tool": "list_traces", "label": "short human description for the header pill",
  "request": { "method": "GET", "path": "/rest/v2/entities", "query": { "k": "v", "multi": ["a","b"] }, "poll": true, "timeoutMs": 90000, "maxBytes": 1048576 } }
```

`WELCOME` answers every `HELLO` and is sent again to all connected extensions when `latestVersion` (the newest release on npm, `null` while unknown) changes. Extensions that do not know the frame ignore it.

Rules:

- `method` is always `GET`; there is no request body. `path` is always relative to the environment base path and starts with `/rest/`. The extension builds `origin + basePath + path + '?' + query`. `query` values are strings, numbers, booleans or arrays (array = repeated parameter); `null`/`undefined` values are skipped. Values are passed verbatim through `URLSearchParams` (the `servicefilter` control characters must survive).
- `environment: null` means the first configured environment. Names match case-insensitively.
- `maxBytes` is optional: the largest response body, in bytes, the extension may relay for this request. Absent or not a positive number → 32 MiB. Values above the 48 MiB ceiling are lowered to it.
- `requestId` is unique per request (not `Date.now()` alone; requests can be concurrent).
- `errorCode` values: `NO_ENVIRONMENT` (none configured), `UNKNOWN_ENVIRONMENT`, `NO_TAB` (could not find or open a tab, the tab left the environment or was closed, or the extension lost its site access), `SESSION_EXPIRED` (see step 7 below), `BLOCKED` (allow-list refused), `HTTP_ERROR` (any other non-2xx; `status` and a body excerpt in `error`), `RESPONSE_TOO_LARGE` (the body is larger than `maxBytes`; `error` states the size reached and the limit), `POLL_TIMEOUT`, `TIMEOUT`, `INTERNAL` (including a network failure that is not a redirect).

## What the extension does with a DT_REQUEST

1. background resolves the environment, checks that it still has site access to its origin (otherwise `NO_TAB` with the instruction to add the environment again) and looks for a usable tab: a tab whose URL is under `origin + basePath` and whose page has a session, i.e. a non-empty `window.csrf_token` (probed in the MAIN world). Loaded tabs are probed first, then tabs that are still loading; a tab without a token (a raw JSON or API page, a page that is logged out) is skipped and the next candidate is tried, up to 8 tabs. The tab that is used is neither activated nor focused. If no candidate has a session, a discarded environment tab is reloaded and probed. If there is still none, the extension opens a normal (not pinned), active tab at `origin + basePath + "/"` in the last-focused normal window and focuses that window, so the user sees it; concurrent first requests share that one tab.
   - Login tab: only a tab the bridge opened this way is ever tracked as the login tab of an environment (`{ tabId, since }` in `chrome.storage.session`, so a service worker restart does not lead to a second tab). If it reaches the environment and has a session, the request runs there and the tab is no longer tracked. Otherwise it stays open, is focused, and the request is answered with `SESSION_EXPIRED` (`loginTab: "opened"`). On later requests, while no other tab is usable, the tracked tab is re-checked: usable → the request runs in it; still signing in → it is focused again and the answer is `SESSION_EXPIRED` (`loginTab: "waiting"`). It is never reloaded, navigated or closed by the bridge.
   - "Still signing in" means: the tab shows a page of the environment's origin outside the environment without a session (the Dynatrace login page; this state does not expire), or it has been anywhere else (an identity provider on another origin, whose URL the extension cannot see, or a page under the environment without a token) for at most 5 minutes since it was opened or last seen on the login page. After that the tab is forgotten and the next request opens a fresh one, so a tab the user has navigated to something unrelated is focused for 5 minutes at most. The tab is also forgotten when it is closed, when it shows a logged-in Dynatrace page of the same origin outside this environment (the request then fails with `NO_TAB`), and when another tab becomes usable.
   - A tab the bridge did not open is never tracked and never focused because it left the environment: if it is closed or navigates away while a request is being delivered, the request fails with `NO_TAB` and a retry picks another tab or opens one. The only case in which the bridge focuses a tab it did not open is an environment tab whose own page reports `SESSION_EXPIRED` for a request (step 7).
2. background checks the allow-list (`extension/allowlist.js`) before forwarding. A refused request never reaches the page.
3. background → `content.js` (ISOLATED) → `inject.js` (MAIN) via `chrome.tabs.sendMessage` and `window.postMessage`, injecting both scripts on demand with `chrome.scripting.executeScript` exactly as kibana-mcp does. `inject.js` re-checks the allow-list. Every injection replaces what an earlier one left in the page (`globalThis.DT_ALLOWLIST` is overwritten, the newest `inject.js` copy is the only one that accepts requests), so a tab that was open while the extension was updated uses the new code without a page reload.
4. `inject.js` reads `window.csrf_token` at request time and runs a `GET` `fetch` with headers `X-CSRFToken` and `Accept: application/json; charset=utf-8`, `credentials: "same-origin"`, `cache: "no-store"` and `redirect: "manual"`.
5. Response size cap: `inject.js` reads the body as a stream and counts bytes. A `Content-Length` above `maxBytes` fails before anything is read; otherwise reading stops and the download is cancelled as soon as the count passes `maxBytes`, so an oversized body is never buffered. Either way the answer is `RESPONSE_TOO_LARGE`. Default 32 MiB, ceiling 48 MiB: Chrome refuses extension messages above 64 MiB (`runtime.sendMessage` throws), and the parsed body is serialised again for that hop, so the ceiling leaves 16 MiB of headroom. If a message is refused anyway, `content.js` answers `RESPONSE_TOO_LARGE` instead of leaving the request to time out.
6. 202 handling when `poll` is true: the body is `{progressValue, progressMaxValue, token}`; repeat the identical request with `prgtkn=<token>` added to the query until the status is not 202, sleeping ~800 ms between polls, bounded by `timeoutMs` → `POLL_TIMEOUT`.
7. `SESSION_EXPIRED` is reported in exactly these cases:
   - `window.csrf_token` is missing or empty when the request is about to be sent (after waiting up to 5 s for a page that is still loading).
   - HTTP 401.
   - The request is redirected (`redirect: "manual"` yields an opaque redirect). It is then repeated once with `redirect: "follow"` to see where it leads: a network-level failure of that followed request (a cross-origin SSO redirect that CORS blocks), or a final URL outside `origin + basePath + "/rest/"` with a body that is not JSON, is `SESSION_EXPIRED`. A redirect that stays inside `/rest/`, or ends in a JSON answer, is treated as a normal response.
   - HTTP 499 (Dynatrace refused the CSRF token) together with a re-read of `window.csrf_token`: missing → `SESSION_EXPIRED`; different from the token that was sent → the request is retried once with the fresh token, and a second 499 with yet another token is `SESSION_EXPIRED`; unchanged → `HTTP_ERROR` 499.

   Nothing is inferred from the words in a response body. A network failure without a redirect is `INTERNAL`, any other non-2xx status is `HTTP_ERROR`, and an HTML body with a 2xx status that came from a `/rest/` URL is returned as text.
8. The CSRF token, cookies and request headers are never logged and never sent over the WebSocket.

Environment registration: the popup's "Add this environment" detects the Dynatrace page by `^/e/([^/]+)` in the path plus a non-empty string `window.csrf_token` (checked in the MAIN world), requests the optional host permission for that origin, and stores `{name, envId, origin, basePath}` if it passes the rules listed under `HELLO`. Default name: the last dash-separated part of `envId` if it is short (`acme-shop-s1` → `s1`), made unique; the user can rename and remove environments in the popup. Environments are stored in `chrome.storage.sync`.

Extension permissions: `activeTab`, `alarms`, `scripting`, `storage`, and no host permission at install time. Site access is requested per Dynatrace origin when an environment is added (`optional_host_permissions`) and removed with the last environment of that origin. The `tabs` permission is not requested: the URL of a tab is only needed for origins the user granted, and the granted host permission already exposes it (for `chrome.tabs.query({ url })` as well); a tab on any other site (an identity provider, for instance) has no visible URL, which is all the login-tab rule above needs. The WebSocket to `ws://localhost` needs no host permission.

## Allow-list (read-only by construction)

One rule set, implemented twice with identical behaviour: `lib/allowlist.js` (server, checked before sending) and `extension/allowlist.js` (checked in background and again in inject). `npm run verify` loads both and checks them against the case table in `scripts/allowlist-cases.js`.

- Method: only `GET`. The bridge has no way to send a body; `POST`, `PUT`, `DELETE`, `PATCH` and everything else are refused.
- Path form: a string starting with `/rest/`, case-sensitive, with no `%` (so no encoded segment can hide a denied word or a separator), no `..`, no `//`, no backslash, no `?` or `#`, no whitespace or control characters.
- Routes: exactly the paths the tools request, nothing by prefix. `{id}` is one path segment of letters, digits, `_`, `.`, `:`, `-`. `/rest/v2/entities`, `/rest/v2/entities/{id}`, `/rest/v2/entityTypes`, `/rest/v2/metrics`, `/rest/v2/metrics/query`, `/rest/v2/problems`, `/rest/v2/problems/{id}`, `/rest/v2/events`, `/rest/v2/settings/schemas`, `/rest/v2/settings/objects`, `/rest/v2/settings/effectiveValues`, `/rest/purepaths/list`, `/rest/serviceanalysis/failure`, `/rest/serviceanalysis/responsetime`, `/rest/serviceanalysis/responsetimedistribution`, `/rest/serviceanalysis/serviceflow`, `/rest/serviceanalysis/servicebacktrace`, `/rest/serviceanalysis/trace`, `/rest/serviceanalysis/servicecalldetails`, `/rest/mda2`, `/rest/mda2/uiDefs`, `/rest/services/servicecontributor`, `/rest/codelevelanalysis/methodhotspots/{id}`, `/rest/codelevelanalysis/threadanalysis/{id}`, `/rest/codelevelanalysis/memoryallocation/{id}`, `/rest/profiling/cpu/pgs`, `/rest/globalAnalysis/processCrash`, `/rest/globalAnalysis/globalAnalysisChart`, `/rest/hosts/{id}`, `/rest/processes/processGroups/{id}`, `/rest/processes/{id}/processdetails`, `/rest/problems/{id}`, `/rest/problems/{id}/model`, `/rest/dashboards/list`, `/rest/dashboards/{id}`, `/rest/config/dashboards/{id}/tiles/{id}` (dashboard tile configuration; nothing else under `/rest/config/`).
- Always denied (deny wins over a matching route): any path containing `apiTokens`, `credentials`, `memoryDumps`, `memorydump` or `tokens`, compared case-insensitively.

A tool that needs a new path adds the route to both files and an allowed case (plus denied neighbours) to `scripts/allowlist-cases.js`, and states in its report why the path is read-only. `npm run verify` fails when a `/rest/…` path literal in `lib/tools/`, `lib/context.js` or `lib/entities.js` is not allowed, when a route is used by no tool, and when a route has no allowed case.

## Server core (`lib/bridge.js`)

- `dt(request, { environment, tool, label })` → resolves with `{ status, data, polls }`, rejects with a `BridgeError` carrying `code` (the `errorCode` above, plus `NO_EXTENSION` when nothing is connected after waiting ~10 s) and a message written for the end user (for `SESSION_EXPIRED`: "log in to Dynatrace again in the tab …").
- Per-environment queue: requests to `/rest/v2/*` run with a concurrency of 4; everything else (analysis endpoints) runs strictly one at a time per environment with a ~250 ms gap.
- Default timeout 90 s per request; the server-side timeout is slightly longer than the `timeoutMs` handed to the extension so the extension's error wins.
- `request.maxBytes` (optional) is passed to the extension untouched; a `RESPONSE_TOO_LARGE` answer becomes a `BridgeError` that states the size reached and the limit and advises a shorter time window or narrower filters. The WebSocket server has an explicit `maxPayload` of 72 MiB (above Chrome's 64 MiB message limit, so no frame a real extension can send is refused); a larger frame closes that connection.
- Several extensions (browsers or profiles) may be connected at once. Every `HELLO` registers the environments of its own connection. A request goes to a connection that has the environment by name (case-insensitive); when several have it, the most recently connected one. `environment: null` means the first environment of the most recently connected extension that has any. When a connection closes, its in-flight requests fail at once with `NO_EXTENSION` and the other connections keep working; a request still waiting in the queue is sent to another connection that has the environment, or fails with `UNKNOWN_ENVIRONMENT` if none has. A `DT_RESULT` is only accepted from the connection the request was sent to.
- `status()` returns `{ connected, ready, extensionVersion, environments, host, port, connections, latestVersion, updateAvailable }`. `connections` lists every connection, newest first: `{ id, ready, version, connectedAt, environments }`. `environments` is the union over all ready connections (newest connection first, a name appears once); `extensionVersion` is the version of the connection that served the most recent request, or of the newest ready connection when none has yet.
- `updateNotes()` returns the notes appended to tool results, each `{ kind, text }`: `extension-outdated` (the extension that was used is older than the server), `server-older` (it is newer than the server), `server-update` (a newer release is on npm; `server.js` adds this one once per MCP session). Versions are compared numerically as major.minor.patch by `compareVersions` in `lib/updates.js`, the only version comparison on the server (the handoff between server instances uses it too); the extension has its own copy with identical behaviour. A version that is not `major.minor.patch` is unknown: the comparison yields `null`, which never counts as newer or older.
- Tools never call the WebSocket directly, only `dt()`.

## Local HTTP endpoint (`server.js`)

The MCP endpoints (`/mcp` Streamable HTTP, `/sse` and `/messages` legacy SSE), `/health` and `/handoff` are served on `HOST:MCP_PORT` for local MCP clients only. Every request passes one gate before any handler runs; a request that fails it gets 403, preflights included:

- `Host` must be `127.0.0.1:<MCP_PORT>`, `localhost:<MCP_PORT>` or `[::1]:<MCP_PORT>` (DNS rebinding protection). Setting `HOST` to another address does not add names.
- `Origin` must be absent (native MCP clients send none) or listed in `DT_BRIDGE_ALLOWED_ORIGINS` (comma- or space-separated origins, empty by default; the escape hatch for a browser-based MCP client). `Origin: null` is refused.
- A request without `Origin` whose `Sec-Fetch-Site` header is neither `same-origin` nor `none` is refused: that is a browser page reaching over with a request that carries no `Origin` (an image, script or form `GET`).
- No `Access-Control-Allow-Origin: *`. CORS headers are sent only to an allow-listed origin, naming that origin.
- The SDK transports are created with `enableDnsRebindingProtection`, the same `allowedHosts` and, when configured, `allowedOrigins`, as a second check.

A request target that is not an absolute path (`//`, `//host/…`, a backslash, anything `URL` cannot parse) gets 400. The request listener cannot produce an unhandled rejection: an error in a handler is logged and answered with 500. `unhandledRejection` and `uncaughtException` are logged; they end the process with exit code 1 while the server is still starting (a broken tool file, a port error) and are survived once it is serving.

`/handoff` (a newer build of this package asks the running one to release the ports and become a stdio proxy): `POST` from a loopback address, through the gate above, with `Content-Type: application/json` (a cross-site form cannot send that without a preflight), a body of at most 4 kB and the header `X-Dynatrace-Bridge-Handoff: <unix ms>.<HMAC-SHA256(secret, "<unix ms>\n<body>") in hex>`, at most 30 s old. The secret is 32 random bytes in `~/.dynatrace-bridge/handoff-secret`, created with mode 0600 by the first server that starts; being able to read it is the proof that the caller runs as the same user, and the secret itself is never sent. Without a valid proof the answer is 403; a caller that is not a newer build, or a primary that is not stdio-managed, gets 409. If the secret file cannot be created, the instance neither hands over nor takes over, and a second instance becomes a stdio proxy of the first as before. The answer of `/health` that identifies a running peer is used only if its version and build are well-formed.

Environment variables of the server: `WS_PORT`, `MCP_PORT`, `HOST`, `EXTENSION_WAIT_MS` (default 10000), `DT_BRIDGE_ALLOWED_ORIGINS`, `DT_BRIDGE_EXTENSION_ORIGINS`, and the update variables below.

## Updates

- Handshake: the server answers `HELLO` with `WELCOME` (`serverVersion`, `latestVersion`). The extension compares numerically (major.minor.patch) and shows, in the popup and in the in-page pill (amber, only while no request is running or failed): "Extension update needed" with the command `npx -y dynatrace-bridge-mcp@latest install-extension`, a copy button and the instruction to click reload on the extensions page, when the extension is older than the server; "MCP server restart needed" when the extension is newer than the server; "Server update available" when `latestVersion` is newer than the server. In the last two cases the instruction is to restart the AI client: its `npx -y dynatrace-bridge-mcp@latest` command then starts the newest server.
- Latest-release check (`lib/updates.js`, started by `bridge.start()`): one `GET https://registry.npmjs.org/dynatrace-bridge-mcp/latest` at startup and then once every 24 h, with a 5 s timeout. It runs in the background, never throws, never delays startup or a tool call, is not retried before the next interval, and keeps its result in memory only. A 404 (package not published), any other non-200 answer, an unparsable body and an offline machine are ignored without a log line. This is the only outbound network request the server makes besides listening for the extension's WebSocket.
- Opt-out: `DT_BRIDGE_UPDATE_CHECK=0` (or `false`) disables the request; `latestVersion` then stays `null`. `DT_BRIDGE_UPDATE_URL` points the check at another registry URL (a mirror); `DT_BRIDGE_SERVER_VERSION` overrides the version the server reports in `WELCOME` and compares against, for trying out the update states by hand.

## Tool modules (`lib/tools/<group>.js`)

Each file has one export:

```js
export const tools = [
  {
    name: "list_traces",
    description: "…",                         // written for the AI: when to use it, what to call next
    inputSchema: (ctx) => ({ type: "object", properties: { …, ...ctx.schema.time(), environment: ctx.schema.environment() }, required: [] }),
    handler: async (args, ctx) => "markdown string"
  },
];
```

`server.js` loads every file in `lib/tools/`, rejects duplicate names at startup, wraps handlers so a thrown error becomes `{ isError: true, content: [{ type: "text", text: "**Error:** …" }] }`, and appends the version-mismatch note as kibana-mcp does. `ctx` gives handlers `ctx.dt`, `ctx.time`, `ctx.servicefilter`, `ctx.format`, `ctx.schema`, `ctx.environments()`; its exact surface is documented at the bottom of this file by the core owner and is the only API tool groups use.

Tool conventions:

- Output is compact markdown, sized for an LLM context: a `#` header line stating what was queried, the environment and the resolved absolute UTC window; then tables or lists; then a `Next:` hint naming the follow-up tools and the ids to pass. Never dump raw JSON payloads.
- Every result ends with a deep link to the matching Dynatrace UI page (routes in `INSPECTION.md`).
- Entity ids (`SERVICE-…`, `SERVICE_METHOD-…`, trace ids, `callURI`) are always printed, because follow-up tools need them.
- Internal endpoints report microseconds; output milliseconds (or s) with units.
- Lists are capped with a `limit` argument and say how many rows were omitted.
- Time arguments are the same on every tool: `minutes_lookback` (default 120), `time_from`, `time_to` (ISO 8601), same semantics as kibana-mcp's `resolveTimeWindow`.
- Undocumented endpoints (`PLAN.md` section 3) get a shape check; on mismatch throw an error saying Dynatrace's internal API changed and naming the missing field.
- Sensitive values are stripped from output: `authorization`, `cookie`, `set-cookie`, `x-csrftoken`, `x-dynatrace*` token headers, and anything that looks like an API token (`dt0c01.…`).
- Entities may be passed by id or by name; resolve names through `/rest/v2/entities` and, when several match, list the candidates instead of guessing.

## Build check

There are no tests in this repo: no mock server, no test suites, no browser automation. `npm run verify` (`scripts/verify.js`) is the single build check. It runs in CI on every push and pull request (`npm ci`, then `npm run verify`), before publishing (`prepublishOnly` and the publish workflow), and it must pass before a change is done. It never opens a browser and never contacts Dynatrace. It checks, in this order:

- Syntax: `node --check` on every `.js` file in the repo root, `lib/`, `lib/tools/`, `scripts/` and `extension/`.
- Version sync: `extension/manifest.json` has the version of `package.json`.
- Extension identity: the manifest `key` is a public key, the id derived from it is the one the server pins and the one stated in this file, and the manifest asks for neither `tabs` nor any host permission at install time.
- i18n parity: `extension/_locales/en` and `tr` have the same keys, every key has a message, and every key referenced from the extension's `.js`, `.html` and `.json` files is defined.
- Allow-list: `lib/allowlist.js` and `extension/allowlist.js` (loaded as the classic script it is) list the same routes and both give the expected verdict, with a reason for every denial, on every case in `scripts/allowlist-cases.js` (percent-encoded paths and every non-GET method among the denied ones); every route has an allowed case; every `/rest/…` path literal in the tool code is allowed and every route is used by one; no tool file sends anything but GET. This is a static check of the read-only boundary; nothing is sent anywhere.
- `install-extension`: copies every file of `extension/`, icons included, into a temporary HOME (run with `--no-open --no-copy`, so no browser is opened and the clipboard is left alone).
- Server: `server.js` starts on free ports with a temporary HOME and the update check disabled, answers `/health` with the package name and version, and lists its tools over MCP (Streamable HTTP) with unique names, descriptions and object-typed input schemas whose `required` names exist.
- HTTP gate: a foreign `Origin`, `Origin: null`, a foreign `Host` and a cross-site `Sec-Fetch-Site` get 403 on `/health`, `/sse`, `/mcp`, `/messages` and `/handoff`, a foreign preflight gets 403 without CORS headers, the three loopback `Host` names work, and malformed request targets get 400 while the server stays up.
- Handoff: the secret file exists with mode 0600; `/handoff` answers 403 without a proof, with a proof made from another secret, for another body or too old, 415 without `Content-Type: application/json`, and 409 (proof accepted, build not newer) for a valid one; the server stays up.
- WebSocket: a client without `Origin` and clients with a web, `null`, other-extension or look-alike origin are refused, the pinned extension origin is accepted, and a `HELLO` with invalid names, origins, base paths and version leaves only the valid environment.

Behaviour against Dynatrace is checked by hand on the real tenant through the installed extension, following `INSPECTION.md`: read-only, one request at a time, never printing tokens or cookies. No tenant data (hostnames, tenant ids, URLs, SQL, trace ids) is ever written into the repo.

## Code style

- No comments in code. Names carry the meaning.
- Plain modern JavaScript, small functions, no classes unless they earn it, no dependencies beyond `@modelcontextprotocol/sdk` and `ws`, no dev dependencies.
- Server logs go to stderr only (stdout belongs to the stdio transport).

## ctx API reference

Source: `lib/context.js` (assembly), `lib/bridge.js`, `lib/time.js`, `lib/servicefilter.js`, `lib/format.js`, `lib/entities.js`. `server.js` builds a fresh `ctx` for every tool call (and for every `inputSchema(ctx)` call, then with `args = {}`). The `ctx` is bound to the tool name and to the call's arguments, so `environment` and `tool` never have to be passed along by hand.

### Server behaviour around a handler

- `inputSchema(ctx)` is evaluated on every `tools/list` and before every call. Arguments named in its `required` array that are missing, `null` or `''` are rejected by the server with ``**Error:** `name` is required`` before the handler runs.
- The handler returns a markdown string. Anything else is an error. Charts are returned as text series (`format.seriesReport`), never as images.
- A thrown error becomes `{ isError: true, content: [{ type: "text", text: "**Error:** <message>" }] }`. Throw plain `Error`s with a message written for the AI and the user; `BridgeError`s from `ctx.dt` already have such a message, so let them propagate.
- All text leaving the server (results and errors) passes through `format.redact`. It masks `dt0c01.…`-style tokens, the value of an `Authorization: <scheme> …` pair, `Bearer` / `Basic` followed by a credential-shaped token (a JWT, or 16+ base64 characters containing a digit, `+`, `/` or `=` padding and not continuing as a dotted identifier), `Api-Token` values and bare JWTs. Class names and prose such as `BasicAuthenticationFilter.doFilter` or "Basic authentication" are left alone.
- Tool order in `tools/list` is deliberate: a tool file may `export const order = <number>` and a single tool may carry its own `order`, which wins over the file's. Tools are listed by ascending order, then by file name, then by position in the file; files without `order` come last (1000). Current values: core 0, services 10, kubernetes 20, traces 30, analysis (including cron jobs and database statements) 40, profiling 60, dashboards 80, `read_settings` 90. A new tool file needs no change in `server.js`. A duplicate name, a missing `tools` export or a tool without `name`, `description`, `inputSchema`, `handler` stops the server at startup.
- Tool files may import constants and pure helpers from `../format.js` for use at module scope (`BRIDGE_NOTE` for descriptions, `metricSelector`, `plural`, `oneLine`, `maskNamed`, …) and `defineTools` from `../context.js`; everything that talks to Dynatrace goes through `ctx`.
- Every tool file exports `tools = defineTools([...])`. The wrapper does two things around each handler, in one place for all tools:
  - Arguments are normalised against the tool's own `inputSchema` before the handler sees them: a numeric string becomes a number, `"true"` / `"false"` a boolean, a number or boolean given for a text argument becomes text, and a comma-separated or JSON string given for a list becomes a list. A value that is none of these is rejected with an error that names the argument (``**Error:** `limit` must be a number, got "ten"``); it is never replaced by the default. `''` and `null` count as "not given".
  - The result passes through `format.fitOutput`: output above the budget of 50,000 characters is cut at a line end, keeps its `Next:` / link footer, and gets a line saying how many characters and lines were cut and how to narrow the call.
- Environment variables: `WS_PORT`, `MCP_PORT`, `HOST`, `EXTENSION_WAIT_MS` (default 10000).

### Requests

| Member | Signature | Returns |
|---|---|---|
| `ctx.dt` | `dt(request, options?)` | `Promise<{ status, data, polls }>` |
| `ctx.get` | `get(path, query?, options?)` | `Promise<data>` |
| `ctx.v2List` | `v2List(path, query?, { itemsKey, limit = 500, pageSize, label, environment })` | `Promise<{ items, totalCount, truncated }>` |
| `ctx.attempt` | `attempt(run, fallback = null)` | `Promise<{ value, note, status }>` |
| `ctx.metrics.query` | `query(selectors, { entitySelector, resolution, time, label })` | `Promise<Map<key, series[]>>` |
| `ctx.metrics.queryForEntities` | `queryForEntities(selectors, ids, { selector = idSelector, resolution, time, label })` | `Promise<Map<key, series[]>>` |
| `ctx.metrics.units` | `units(metricIds, { label })` | `Promise<{ units, unit(id, assumed), formatter(id, assumed), note() }>` |
| `ctx.serviceRequests` | `serviceRequests(service, { filter, time, label })` | `Promise<{ data, rows, warnings, skipped }>` |
| `ctx.mda` | `mda({ metric, dimension, filter, service, mergeServices, timeseries, percentile, aggregation, requestAttributeId, time, label })` | `Promise<{ rows, unit, capNote, … }>` |

- `request`: `{ path, query = {}, poll = true, timeoutMs = 90000, maxBytes }`. The bridge sends only `GET`; there is no way to send a body. `maxBytes` is the largest response body the extension relays for this request (default 32 MiB, ceiling 48 MiB); a larger answer fails with `RESPONSE_TOO_LARGE`. `path` starts with `/rest/` and carries no query string. `query` values are strings, numbers, booleans or arrays (repeated parameter); `null` / `undefined` are skipped, so optional parameters can be written as `servicefilter: ctx.servicefilter.encode(filter)`.
- `options`: `{ label, environment, tool }`. `label` is the short human text for the header pill (default `"GET /rest/…"`); `environment` defaults to `args.environment`; `tool` defaults to the tool name. `get` also accepts `poll`, `timeoutMs` and `maxBytes` in `options`.
- `data` is the parsed JSON body (or a string when the body is not JSON). `polls` is the number of `prgtkn` polls the extension needed.
- The allow-list is checked before anything is sent. `/rest/v2/*` runs 4 at a time per environment, every other path one at a time with a 250 ms gap, so `Promise.all` over analysis requests is safe but not faster.
- `v2List` pages through any `/rest/v2` list (`entities`, `metrics`, `problems`, `events`, `entityTypes`, …): the first request sends `query` plus `pageSize` (default `min(limit, 500)`), later ones only `nextPageKey`, until `limit` items are collected (max 20 pages). `itemsKey` is the array property (`'entities'`, `'metrics'`, `'problems'`, `'events'`, `'types'`); when omitted the first array in the response is used. `totalCount` is Dynatrace's count, `truncated` says more exist than were returned.

- `attempt` runs an optional part of a tool: it resolves to `{ value, note: null }`, or to `{ value: fallback, note, status }` when `run` failed softly (`HTTP_ERROR`, `POLL_TIMEOUT`, `TIMEOUT`, `RESPONSE_TOO_LARGE`, or a shape mismatch from `expectShape`); `note` is the one-line error text to print, `status` the HTTP status if any. Every other error propagates. Typical use: `ctx.attempt(async () => ctx.expectShape(await ctx.get(path, query, { label }), shape, endpoint))`.
- `metrics.query` runs one `/rest/v2/metrics/query` for several selectors. A selector is a string (keyed by its metric id, e.g. `builtin:containers.cpu.usageMilliCores`) or a `[key, selector]` pair when one metric is queried with several transformations. Each value is the series list of `format.metricSeries` (`{ label, shortLabel, dimensionMap, timestamps, values }`, Dynatrace's missing-value sentinel already turned into `null`). Build selectors with `format.metricSelector.splitBy(...dimensions)`, `.eq(dimension, value)`, `.in(dimension, entitySelector)`; take one value per entity from an `Inf`-resolution result with `format.valueByDimension(series, dimension)`.
- `metrics.queryForEntities` is `metrics.query` for a list of entity ids: the ids are split into chunks whose `selector(chunk)` (default `entityId("A","B",…)`) stays under the selector budget (see Entities), one query runs per chunk and the series are concatenated per key. Use it instead of building an `entitySelector` from a list of ids; split the selectors by the entity dimension, otherwise each chunk contributes its own aggregate series.
- `metrics.units` reads the units of the given metrics from their descriptors (`GET /rest/v2/metrics`, one request) so that no tool has to hard-code them. `unit(id, assumed)` returns the descriptor's unit, or `assumed` when Dynatrace names none or the lookup failed; `formatter(id, assumed)` is `format.formatterForUnit` of that; `note()` is `null`, or the one line to print that lists the metrics whose unit had to be assumed. Checks that compare a value with a threshold (percent, millicores) must first test `unit(id, assumed) === assumed`.
- `serviceRequests` reads `GET /rest/services/servicecontributor` for one service entity (`sci`, the encoded `filter`, the window) and checks its shape. `rows` are `{ id, name, calls, avg, median, p90, max, total, failureRate, cpu, http4xx, http5xx, databaseStatement, unreliable }` (times in µs; `failureRate` is read as a percentage, a scale that is not verified live, so tools that print or compute with it say so; server-side values, client-side ones for external services); `warnings` are texts for `format.warningLine` (partial result, skipped rows, sampling); `skipped` is the number of rows Dynatrace itself left out (0 when none), which a tool that re-sorts the rows must mention.
- `mda` reads `GET /rest/mda2`. It always sends `timeseries` (the endpoint rejects the request without it), sends `aggregation` and `percentile` only when given, and scopes to `service` (an entity from `ctx.entities.service`) by adding the service-name filter (type 50) and, for a `DATABASE_SERVICE`, the database call-type filter (type 26 = 0), because the endpoint ignores `serviceId`. It returns `rows` (`{ name, id, parts, serviceId, totals, timeseries, unreliable }`; `totals` are Dynatrace's aggregates under its own names: for time metrics `AVERAGE`, `MEDIAN`, `P90`, `P95`, `CUSTOM_PERCENTILE`, `MIN`, `MAX`, `SUM` and `LOAD` (the number of requests), for count metrics `COUNT`, `COUNT_PER_MINUTE`, `LOAD`, `AVERAGE`, `MIN`, `MAX`, of which only `COUNT`, the total Dynatrace ranks by, has an established meaning, so print the others under their raw names; `id` is the first entity id among `uiMda2DimensionParts`, `parts` the raw parts; rows of other services with the same name and rows without totals are already removed), `unit`, `merged`, `servicefilter` (the encoded filter that was sent), `foreign`, `withoutTotals`, `omittedUnreliable`, `returned`, `total`, `capNote` (text when Dynatrace cut the list to its top 100, else `null`; the cut is by the largest total, so a tool that ranks by anything else must say that its order covers only those rows), `serviceNames` and `serviceTypes` (per service id), `warnings`, and the raw `data` / `result`.

Errors: every failure rejects with a `BridgeError` (`ctx.BridgeError`) with `code` and a user-facing `message`; `status` (HTTP status or `null`), `environment` and `detail` are set when the extension answered.

| `code` | When |
|---|---|
| `NO_EXTENSION` | no extension connected (and said `HELLO`) within `EXTENSION_WAIT_MS`, or it disconnected mid-request |
| `NO_ENVIRONMENT` | the extension has no environment configured |
| `UNKNOWN_ENVIRONMENT` | `environment` matches no configured name (message lists the names) |
| `BLOCKED` | refused by the allow-list (server side, before sending, or by the extension) |
| `SESSION_EXPIRED` | 401, login page or no CSRF token; the message tells the user where to log in |
| `HTTP_ERROR` | any other non-2xx; `error.status` holds the code, the message holds Dynatrace's error text |
| `POLL_TIMEOUT` | the 202 loop did not finish within `timeoutMs` |
| `TIMEOUT` | the extension did not answer within `timeoutMs` + 5 s |
| `RESPONSE_TOO_LARGE` | the response body exceeded `maxBytes`; the message tells the AI to shorten the window or narrow the filters |
| `NO_TAB`, `INTERNAL` | as reported by the extension |

To handle one case and pass the rest on: `catch (e) { if (e instanceof ctx.BridgeError && e.code === 'HTTP_ERROR' && e.status === 404) …; else throw e; }`.

### Environment and status

| Member | Returns |
|---|---|
| `ctx.environments()` | `[{ name, envId, origin, basePath }]` as reported by the extension (first = default) |
| `ctx.environment(name = args.environment)` | that environment object (case-insensitive; no name = default) or `null` |
| `ctx.status()` | `{ connected, ready, extensionVersion, environments, host, port, connections: [{ id, ready, version, connectedAt, environments }], latestVersion, updateAvailable, serverVersion, mcpPort }`; never waits. `connections` lists every connected browser, newest first; `latestVersion` is the newest published package version or `null`, `updateAvailable` whether it is newer than this server |
| `ctx.toolName`, `ctx.args` | the tool name and the raw arguments of this call |

### Time

`ctx.time(args = ctx.args, defaultLookback = 120)` reads `minutes_lookback`, `time_from`, `time_to` and returns the window below. Rules (`lib/time.js`):

- `time_from` / `time_to` are ISO 8601 (`2026-09-23`, `2026-09-23T10:28`, `2026-09-23 10:28:00.123`, with `Z` or `±hh:mm`), or epoch milliseconds. A timestamp without a zone designator is UTC, whatever the server's local zone; a date without a time is midnight UTC. Anything else (`"yesterday"`, an impossible date) is an error naming the argument.
- `minutes_lookback` is a positive number or a numeric string; anything else, including 0 and negative values, is an error. With neither `time_from` nor `time_to` it means the last N minutes; with only `time_to`, the N minutes before it; with `time_from` it is ignored.
- `time_from` must be earlier than `time_to` and must not lie in the future; `time_to` may be at most 5 minutes ahead of the server clock. Each violation is an error that states both times in UTC; nothing is clamped or swapped silently.

The result:

| Field | Example | Use |
|---|---|---|
| `fromMs`, `toMs` | `1790762400000` | numbers |
| `fromIso`, `toIso` | `'2026-09-30T10:00:00.000Z'` | |
| `lookbackMin` | `120` or `null` for absolute windows | |
| `durationMs` | `7200000` | |
| `gtf` | `'c_1790762400000_1790769600000'` | global timeframe parameter and deep links |
| `timeframe` | `'custom1790762400000to1790769600000'` | analysis endpoints |
| `from`, `to` | `'1790762400000'` | `/rest/v2` parameters |
| `v2Query` | `{ from, to }` | spread into a `/rest/v2` query |
| `analysisQuery` | `{ gtf, timeframe }` | spread into an internal-endpoint query |
| `describe` | `'2026-09-30 10:00:00 → 2026-09-30 12:00:00 UTC (2 h)'` | header line |

Windows are always absolute, also for "last N minutes", so the header and the data agree.

### Schema fragments

| Call | Gives |
|---|---|
| `...ctx.schema.time(defaultLookback = 120)` | the properties `minutes_lookback`, `time_from`, `time_to` (spread) |
| `environment: ctx.schema.environment()` | the `environment` property; its description lists the configured names |
| `...ctx.schema.serviceFilter({ omit = [] })` | the shared trace filter properties (see servicefilter) (spread); `omit` leaves out the named ones |
| `limit: ctx.schema.limit(defaultLimit, what = 'rows', max)` | a `limit` property; its description states the default and, when `max` is given, the maximum |
| `service: ctx.schema.entity(what, exampleId)` | an "id or name" property, e.g. `ctx.schema.entity('The service', 'SERVICE-1234567890ABCDEF')` |

`ctx.limit(value, defaultLimit, max = 1000, name = 'limit')` turns a limit argument into an integer: not given → `defaultLimit`; a number or numeric string of 1 or more → that, lowered to `max`; anything else → an error naming `name`. Pass the same `max` to `ctx.schema.limit` so the description states it, and pass `name` for every argument that is not called `limit`.

`ctx.number(value, name, { fallback = null, min, max, integer = false })` does the same for any other numeric argument: `fallback` when not given, an error naming `name` when it is not a number or outside `min` / `max`.

`limit` is how many rows a tool prints, not how many it reads from Dynatrace. Keep print maxima small enough for an LLM context (the tools use 50 to 400) and use a separate, documented argument when more must be fetched to rank well (`fetch_limit` of `list_traces`). When a tool sorts or filters rows that Dynatrace already cut (its top 100 of `/rest/mda2`, its newest N traces, `skipped` contributors), the output must say that the order covers only those rows.

### servicefilter

Shared tool arguments from `ctx.schema.serviceFilter()`: `response_time_min_ms`, `response_time_max_ms`, `http_code` (`'404'`, `'4xx'`, `'400-599'`), `failed` (boolean), `http_method`, `request` (a `SERVICE_METHOD-…` id, or a request name or part of one, looked up within `service`), `request_group_id` (`SERVICE_METHOD_GROUP-…`) with `request_group_name`, `url_contains` (web requests only), `request_kind` (`'web'` or `'database'`), `raw_filters` (`[{ type, values }]`).

| Member | Signature | Returns |
|---|---|---|
| `ctx.servicefilter.resolve` | `resolve(args = ctx.args, { service, time })` | `Promise<filter input>`; resolves a `request` given by name |
| `ctx.servicefilter.fromArgs` | `fromArgs(args)` | filter input, synchronously; throws when `request` is a name |
| `ctx.servicefilter.encode` | `encode(input)` | the `servicefilter` string, or `undefined` when the input has no filter |
| `ctx.servicefilter.decode` | `decode(string)` | `{ version, filters: [{ type, name, values }], input }` (`input` is the filter input again) |
| `ctx.servicefilter.describe` | `describe(input)` | text for the header, e.g. `'response time ≥ 2000 ms, HTTP 400-499, failed only'`, `''` when empty |
| `ctx.servicefilter.TYPES` | | name → numeric type id for all known types (`TRACE_ID: 41`, …) |

The filter input is `{ responseTimeMinMs, responseTimeMaxMs, httpCode, failed, httpMethod, requestId, requestName, requestGroup: { id, name }, urlContains, requestKind, serviceName, raw: [{ type, values }] }` (only the keys that were given). `requestName` is only used by `describe`. Encoding order: the named keys in that order, then `raw`, then `requestKind`, then `serviceName`.

Every tool with the shared arguments calls `await ctx.servicefilter.resolve(args, { service, time })`, where `service` is the resolved service entity or `null`. A `request` that is an id needs no lookup. A name is matched against the requests of `service` through `ctx.serviceRequests` (exact name first, then substring, both case-insensitive): one match becomes `requestId` (or `requestGroup` when the service's rows are request groups, as for "Requests to unmonitored hosts"); several matches or none throw an error that lists the candidates with their ids; a name without `service` throws an error that points to `url_contains`.

A tool may add to the input before encoding, e.g. `{ ...filter, requestId }` or `raw: [{ type: 'TRACE_ID', values: [id] }]`. Milliseconds are converted to microseconds; an open maximum is `4611686018427387`. The types verified live (0, 2, 3, 6, 9, 10, 26, 30, 50; `PLAN.md` 3.2) have named keys: `requestKind: 'database'` is type 26 = `0`, `requestKind: 'web'` is the two filters 26 = `2` and 26 = `1` (web request and web service; several filters of one type are ORed), `serviceName` is type 50. Every other type goes through `raw` with a numeric id or a name from `TYPES`, and its value format is the tool author's responsibility to verify.

### Entities

| Member | Signature | Returns |
|---|---|---|
| `ctx.entities.resolve` | `resolve(idOrName, { type, fields, time, what = 'entity' })` | `Promise<entity>` |
| `ctx.entities.get` | `get(id, { fields, time, label })` | `Promise<entity>`; a 404 becomes "No entity … found" |
| `ctx.entities.list` | `list(entitySelector, { fields, time, limit = 50, sort = 'name', label })` | `Promise<{ entities, totalCount }>` |
| `ctx.entities.listByIds` | `listByIds(ids, { selector = idSelector, fields, time, limit, sort, label })` | `Promise<{ entities, totalCount, requests }>`: `list` for a list of ids, chunked (see below), results merged and de-duplicated |
| `ctx.entities.idSelector` | `idSelector(ids)` | `'entityId("A","B")'` |
| `ctx.entities.chunkIds` | `chunkIds(ids, build = idSelector, budget = 1500)` | `ids[][]`: consecutive chunks for which `build(chunk)` is at most `budget` characters long |
| `ctx.entities.service` | `service(idOrName, { time, fields = [], what = 'service' })` | `Promise<entity>`: `resolve` for type `SERVICE`, always with `properties.serviceType` |
| `ctx.entities.resolveOne` | `resolveOne(args, { argument: TYPE, … }, { time, fields: { argument: [...] } })` | `Promise<{ key, entity }>` for tools that take exactly one of several entity arguments (`workload` / `pod`, `service` / `process_group`); throws "pass exactly one of …" otherwise |
| `ctx.entities.names` | `names(ids, { time })` | `Promise<Map<id, displayName>>` (chunked requests per entity type, unknown ids omitted). The map has a `note` property: `null`, or the one line to print when a lookup failed, so ids without names are never shown without an explanation |
| `ctx.entities.isId` | `isId(value)` | `true` for `TYPE-16HEXDIGITS` |
| `ctx.entities.typeOf` | `typeOf(id)` | `'SERVICE'`, `'CLOUD_APPLICATION_INSTANCE'`, … or `null` |
| `ctx.entities.quote` | `quote(text)` | `"text"` escaped for an entitySelector |
| `ctx.entities.fields` | `fields(listOrString)` | `'+a,+b'` or `undefined` |

`entity` is the `/rest/v2/entities` object: `{ entityId, displayName, type, … }` plus whatever `fields` asked for (`'properties'`, `'properties.cloudApplicationInstancePhase'`, `'tags'`, `'managementZones'`, `'fromRelationships'`, `'toRelationships.isInstanceOf'`, `'firstSeenTms'`, `'lastSeenTms'`; the `+` is added for you). `type` is one type or an array.

Selectors built from id lists: Dynatrace rejects an entity selector longer than about 2,000 characters with HTTP 400 (50 pod ids are already 2,309). Never join a list of ids into a selector by hand. `listByIds` and `metrics.queryForEntities` split the list by the actual length of the selector that `selector(chunk)` builds, with a budget of 1,500 characters (`SELECTOR_BUDGET` in `lib/entities.js`), and merge the results; `selector` wraps the id list, e.g. ``ids => `type(CONTAINER_GROUP_INSTANCE),fromRelationships.isCgiOfCai(${ctx.entities.idSelector(ids)})` ``. With `listByIds`, `limit` applies per chunk (default: the chunk's size).

`resolve` with an id fetches that entity (and throws if its type is not one of `type`). With a name it needs `type`, tries `entityName.equals` and then `entityName.contains`; exactly one match is returned, several throw an error that lists the candidates with their ids, none throws "No SERVICE named …". `what` names the argument in error messages.

### Output

`ctx.header(title, { time, details = [], environment })` → ``# title (details…, env `name`, <time.describe>)``. Falsy `details` entries are dropped.

`ctx.link(route, { params = {}, time, environment })` → the absolute UI URL for the call's environment. `time` appends `gtf`. Routes starting with `#` are GWT routes and get `;key=value` parameters, everything else gets a query string:

| Page | Call |
|---|---|
| Service | `ctx.link('#smgd', { params: { sci: serviceId }, time })` |
| Failure analysis | `ctx.link('#failureanalysis', { params: { sci, timeframe: time.timeframe }, time })` |
| Response time analysis / distribution | `'#responsetimeanalysis'`, `'#responsetimedistribution'` with `sci` |
| Service flow / backtrace | `'#serviceflow'`, `'#servicebacktrace'` with `sci` |
| Trace | `ctx.link('#trace', { params: { traceId, callURI }, time })` |
| Method hotspots | `ctx.link('#methodhotspots', { params: { entityId }, time })` |
| Problem / visual resolution path | `ctx.link('#problems/problemdetails', { params: { pid } })`, `'#vres'` with `pid` |
| Host / process / process group | `'#newhosts/hostdetails'`, `'#processdetails'`, `'#processgroupdetails'` with `id` |
| Process crashes | `'#processcrashesglobal'` |
| Any entity / entity list | `` ctx.link(`ui/entity/${id}`, { time }) ``, `` ctx.link(`ui/entity/list/${TYPE}`, { time }) `` |
| Services, databases, problems | `'ui/services'`, `'ui/databases'`, `'ui/problems'` |
| Traces of a service / all | `` `ui/services/${id}/purepaths` ``, `'ui/diagnostictools/purepaths'` |
| Multidimensional analysis | `ctx.link('ui/diagnostictools/mda', { params: { mdaId: 'topweb' }, time })` |
| Profiling | `'ui/diagnostictools/profiling/cpu'`, `` `ui/diagnostictools/${pgId}/threadanalysis` ``, `` `ui/diagnostictools/${pgId}/memoryallocation` `` |
| Environment home | `ctx.link('')` |

`ctx.expectShape(data, paths, endpoint)` returns `data` or throws "Dynatrace's internal API changed: the response of <endpoint> has no `path`" (an error with `code: 'API_CHANGED'`). `paths` are dotted: a trailing `[]` requires an array (`'analysisResult.dimensions[]'`), and `[]` in the middle checks the rest of the path on the first item of that array when it has one (`'topContributors[].metrics'`). Use it on every undocumented endpoint; `format.apiChanged(endpoint, problem)` builds the same error for checks a path cannot express.

`ctx.format` (all pure; missing or non-numeric values print as `-`):

| Function | Result |
|---|---|
| `duration(micros)` | `'850 µs'`, `'12.3 ms'`, `'2.5 s'`, `'1.5 min'`, `'2 h'` |
| `durationMs(millis)` | same, input in ms |
| `bytes(n)` | `'512 MiB'` |
| `percent(n, { ratio })` | `'12.3 %'` (`ratio: true` multiplies by 100) |
| `count(n)` | `'9999'`, `'12.3k'`, `'4.56M'` |
| `number(n, digits = 3)` | 3 significant digits |
| `formatterForUnit(unit)` | a formatter for a Dynatrace metric unit (`'MicroSecond'`, `'Byte'`, `'Percent'`, `'Count'`, `'PerMinute'`, …) |
| `utc(msOrIso, { seconds, millis, zone })` | `'2026-10-01 08:05:09Z'` |
| `timestamp(value)` | epoch milliseconds of an ISO 8601 timestamp (without a zone: UTC) or of epoch milliseconds given as text; `null` when it is neither |
| `truncate(text, max = 200)`, `truncateStart(text, max = 40)` | cut with `…` at the end, or at the start (for names that differ at the end, such as pods) |
| `oneLine(text)`, `plural(count, noun)`, `tag(tag)` | whitespace collapsed to single spaces; `'2 processes'`; a Dynatrace tag object as `key:value` |
| `refId(ref)`, `refLabel(ref)` | id and `'name (id)'` of an entity reference in any of the shapes the v2 API uses |
| `table(headers, rows)` | markdown table (cells escaped), `''` when there are no rows |
| `cap(items, limit)` | `{ shown, omitted, note }` |
| `omittedNote(omitted, hint?)` | `'_N more omitted (…)_'` or `''` |
| `stackTrace(textOrFrames, maxFrames = 8)` | top frames plus `'… N more frames'` (`null` = all) |
| `stripHeaders(headers)` | object or array of `{ name, value }` / `[name, value]` without authorization, cookie, set-cookie, CSRF and `x-dynatrace*` headers; the remaining values go through `maskNamed` |
| `isSensitiveHeader(name)`, `isSecretName(name)`, `redact(text)` | the building blocks of the above and of the masking helpers below |
| `fitOutput(text, budget = 50000)` | the text, or its head up to the budget plus a line saying what was cut and the footer (applied by `defineTools`) |
| `assumedNote(assumptions)` | `'_Assumed, not verified against a live Dynatrace: a; b._'` or `null`: the line to print when a unit, scale or field meaning is not backed by `PLAN.md` |
| `seriesStats(timestamps, values)` | `{ points, min, minAt, max, maxAt, avg, sum, last, lastAt, firstAt, trend: { direction, changePercent }, peaks: [{ t, v }] }` or `null` |
| `downsample(timestamps, values, buckets = 24, range?)` | `[{ from, to, points, min, max, avg }]` |
| `describeTrend(trend)` | `'rising (+35 %)'`, `'flat (0 %)'`, `'n/a'` |
| `seriesSummary(timestamps, values, { format, buckets = 24, label })` | one series: stats line, peaks, compact time table |
| `metricSeries(queryResult)` | `/rest/v2/metrics/query` response → `[{ metricId, warnings, series: [{ label, shortLabel, dimensionMap, timestamps, values }] }]` |
| `seriesReport(series, { format, buckets = 24, maxSeries = 10, columns = 5, overTime = true })` | several series (`[{ label, shortLabel?, timestamps, values }]`): stats table ranked by average plus one time table (`overTime: false` = stats table only); usable for any time series, not only metrics |
| `pointSeries(points)` | `[{ timestamp, value }]` or `{ dataPoints: [...] }` of an internal endpoint → `{ timestamps, values }`, with Dynatrace's missing-value sentinel (-1.101e+101) as `null` |
| `metricSelector.splitBy / eq / in / key`, `valueByDimension(series, dimension)` | metric selector builders and "one value per entity" (see Requests) |
| `statsLine(label, stats, format)`, `bucketLabel(ms, spanMs)` | `'- label: min … · avg … · max … at … · last … · trend …'` from `seriesStats`; the time label used in time tables |
| `analysisWarnings(metadata, debug?)`, `warningLine(warnings)` | texts for partial timeframe, partial result, analysis state, sampling, cluster nodes from an analysis endpoint's metadata; `'**Warning:** a; b.'` or `null`. The warning line goes right under the header |
| `tree(roots, { childrenOf, line, maxDepth, limit })` | indented list of a tree: `{ text, lines, beyondLimit, beyondDepth, notes }`; `line(node, depth)` returns one line or several |
| `eventProperties(event)`, `groupEvents(events, keyOf, timesOf?)` | event properties as an object; identical events collapsed into `{ members, count, open, first, last, latest, entities }`, newest group first |
| `maskNamed(name, value, { opaque = true })` | the one helper for a named value from Dynatrace (request parameter, request attribute, header, OneAgent attribute, entity property): `<masked>` when the name looks like a secret (password, token, secret, key, credential, authorization, session id, signature, …), otherwise `maskString(value)` (or `maskInline` with `opaque: false`, for values such as pod names that may be long identifiers); objects and arrays go through `maskSecrets` |
| `maskSecrets(value)`, `maskString(text)` | a settings or configuration value with passwords, tokens, keys and opaque secrets replaced by `<masked>`, by key name and by value shape (PEM blocks, JWTs, Dynatrace tokens, 40+ character opaque strings) |
| `maskInline(text)` | text that stays readable (a URL, a message): passwords in `scheme://user:password@`, secret-named query parameters (`?password=…&access_token=…`) and everything `redact` covers are masked, the rest is untouched |
| `BRIDGE_NOTE` | the closing paragraph of every tool description |
| `seriesLabel(dimensionMap, dimensions, { ids })` | `'name (ID)'` label of a metric series |
| `sections(...blocks)` | joins blocks with blank lines, dropping `null`, `''`, `false`; arrays are flattened one level |
| `footer({ next, link })` | `'Next: …'` and `'[Open in Dynatrace](url)'` |
| `header`, `deepLink`, `expectShape`, `apiChanged` | what `ctx.header`, `ctx.link`, `ctx.expectShape` call |

Every result is built as `format.sections(ctx.header(…), format.warningLine(…), body…, format.omittedNote(…), format.footer({ next, link: ctx.link(…) }))`. Headings are followed by a blank line; `Next:` starts with an imperative (`call …`) and names the tool and the argument values to pass.

### A complete tool

`lib/tools/example.js`:

```js
import { BRIDGE_NOTE } from '../format.js';
import { defineTools } from '../context.js';

export const order = 35;

export const tools = defineTools([
  {
    name: 'slowest_requests',
    description: [
      'Lists the requests of one service by average response time. Pass `service` as an id or a name.',
      '',
      BRIDGE_NOTE,
    ].join('\n'),
    inputSchema: (ctx) => ({
      type: 'object',
      properties: {
        service: ctx.schema.entity('The service', 'SERVICE-1234567890ABCDEF'),
        ...ctx.schema.serviceFilter(),
        limit: ctx.schema.limit(25, 'requests', 200),
        ...ctx.schema.time(),
        environment: ctx.schema.environment(),
      },
      required: ['service'],
    }),
    handler: async (args, ctx) => {
      const { format } = ctx;
      const time = ctx.time(args);
      const service = await ctx.entities.service(args.service, { time });
      const filter = await ctx.servicefilter.resolve(args, { service, time });
      const { rows, warnings } = await ctx.serviceRequests(service, { filter, time });

      const ranked = [...rows].sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));
      const { shown, omitted } = format.cap(ranked, ctx.limit(args.limit, 25, 200));
      return format.sections(
        ctx.header(`Slowest requests of ${service.displayName}`, { time, details: [service.entityId, ctx.servicefilter.describe(filter)] }),
        format.warningLine(warnings),
        format.table(['id', 'request', 'calls', 'avg response time'], shown.map(r => [r.id, r.name, format.count(r.calls), format.duration(r.avg)])) || '_No requests in this window._',
        format.omittedNote(omitted),
        format.footer({
          next: shown.length ? `call \`list_traces\` with \`service: "${service.entityId}"\` and \`request\` set to an id from the table.` : null,
          link: ctx.link('#smgd', { params: { sci: service.entityId }, time }),
        }),
      );
    },
  },
]);
```
