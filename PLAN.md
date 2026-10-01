# Dynatrace Bridge MCP — Plan

An MCP server plus a browser extension that lets an AI assistant query Dynatrace Managed through the user's logged-in browser tab. Same architecture as `~/projects/kibana-mcp` (kibana-bridge-mcp): no API tokens, the browser session is the credential.

Investigated on 2026-10-01 against a Dynatrace Managed environment at `https://<cluster-host>/e/<environment-id>/`
(classic UI, version 1.346, SAP Commerce Cloud tenant). Every endpoint below was replayed with a plain in-page `fetch` unless marked otherwise.

## 1. How access works

| Route | Result with the browser session |
|---|---|
| `/api/v2/*` (public API) | `401 Missing authorization parameter` — needs an Api-Token |
| `/rest/*` without CSRF header | `499 Request rejected - an attempt to run protected command was detected` |
| `/rest/*` with `X-CSRFToken` | `200` |

- The CSRF token is the page global `window.csrf_token`. Session cookies are httpOnly, so requests must run inside the page.
- Required headers: `X-CSRFToken`, `Accept: application/json; charset=utf-8` (plus `Content-Type` for POST). The UI's `Tab-Id` / `X-Last-Action` headers are not needed.
- Base path is `/e/{environmentId}`.
- The pages have a strict CSP (no `eval`, nonce-only inline scripts on the Angular pages). The extension must inject with `chrome.scripting.executeScript({world: "MAIN"})`, as kibana-mcp does; that is not subject to page CSP.
- **Async pattern:** analysis endpoints answer `202 {progressValue, progressMaxValue, token}`. Repeat the same request with `&prgtkn={token}` until `200`.
- **Timeframe:** `gtf=l_2_HOURS | l_24_HOURS | l_7_DAYS | c_{fromMs}_{toMs}`; analysis endpoints also take `timeframe=last2h | custom{fromMs}to{toMs}`. `/rest/v2` uses `from` / `to` (ms or `now-2h`). Internal endpoints reject the relative UI form (`gtf=-2h`); the bridge always sends absolute `c_{fromMs}_{toMs}` windows.
- Two UI generations share one backend: Angular pages under `/ui/...` and older GWT pages under `/#...`. Both call the same `/rest` API.

## 2. `/rest/v2/*` — mirror of the public API v2

Same paths, parameters and shapes as documented `/api/v2`. The OpenAPI specs are downloadable with the session: `/rest/v2/rest-api-docs/v2/spec3.json` (188 paths), `.../v1/spec3.json` (85), `.../config/v1/spec3.json` (238). The server can load the spec at runtime to validate parameters.

| Area | Status | Notes |
|---|---|---|
| `entities`, `entities/{id}`, `entityTypes` | 200 | all entity types: SERVICE, HOST, PROCESS_GROUP(_INSTANCE), CLOUD_APPLICATION (workload), CLOUD_APPLICATION_INSTANCE (pod), CONTAINER_GROUP_INSTANCE (container), KUBERNETES_CLUSTER/NODE/SERVICE, QUEUE… |
| `metrics`, `metrics/{id}`, `metrics/query` | 200 | full metric selector language |
| `problems`, `problems/{id}`, `problems/aggregate` | 200 | `fields=+evidenceDetails,+impactAnalysis,+recentComments` |
| `events`, `eventTypes`, `eventProperties` | 200 | includes Kubernetes pod events |
| `slo`, `releases`, `units`, `networkZones` | 200 | |
| `settings/schemas`, `settings/objects`, `settings/effectiveValues` | 200 / 403 | the schema list is readable; in this tenant the objects and effective values of most schemas answer 403 for the logged-in user, so `read_settings` is of little use here |
| `hub/*` | 200 | not useful |
| `logs/*` | **403** `storage:logs:read` | no log access for this user; logs stay in Kibana |
| `securityProblems`, `attacks`, `extensions`, `activeGates`, `oneagents` | 403 | no permission |
| `synthetic/*`, `auditlogs` | 404 | not mirrored |
| `apiTokens`, `credentials` | 200 | **must be blocked by the bridge** (sensitive) |

UI-only additions under `/rest/v2`: `POST /rest/v2/entities/suggest` (filter value suggestions), `POST /rest/v2/ua/list` and `POST /rest/v2/ua/entity` (screen definitions for entity pages, including the metric selectors behind each chart). The bridge is GET-only, so tools cannot use these.

## 3. Internal endpoints (undocumented)

### 3.1 Traces

| Purpose | Endpoint | Key params / response |
|---|---|---|
| Trace list | `GET /rest/purepaths/list` | `serviceId` (optional = whole environment; verified to scope the result to that service), `servicefilter`, `purepathsLimit` (≤3000), `purepathsDataSource=ALL`, `partialResult=false`. Per trace: name, callURI, traceIdHex, failed, HTTP code/method/URL, timings (µs: response, cpu, wait, suspension, sync), exception class counts, DB/service call counts and time, request attributes |
| Trace chart | `GET /rest/purepaths/chart` | count + median response time series |
| Trace tree | `GET /rest/serviceanalysis/trace` | `traceId`, `callURI`. `header` + `nodeData` (pipe table, 27 fields/node, names by index into `stringMap`) |
| Trace node details | `GET /rest/serviceanalysis/servicecalldetails` | `callURI`, `span=NO_SPAN`. Exceptions with stack traces, code-level method tree with cpu/self/wait, downstream calls with SQL text and multiplicity, request/response headers, pod/host, technologies |

`nodeData` columns: `[0] id, [1] parentId, [2] callURI, [3] serviceName→stringMap, [4] name→stringMap, [5] icon→iconMap, [6] multiplicity, [7] clientStart µs, [8] clientEnd, [9] serverStart, [10] serverEnd, [12] node kind (1 = database call), [14] suspension, [15] wait, [17] cpu, [18] self time, [21] server response time`. Database and other client-only nodes have no server times; their duration is `clientEnd − clientStart`. Columns 11, 13, 16, 19, 20, 22–26 are unidentified.

### 3.2 The `servicefilter` language (decoded)

Used by trace list, MDA and every service analysis endpoint. This is what makes "filter this host's requests by response time" possible.

```
servicefilter = "0" \x1e filter ( \x10 filter )*
filter        = typeId \x11 value ( \x14 value )*
```

Verified against live data:

| typeId | Name | Value | Verified |
|---|---|---|---|
| 0 | RESPONSE_TIME | `minµs \x14 maxµs` (open max = `4611686018427387`) | yes |
| 2 | RESPONSE_CODE | `404`, `400-499`, `400-599` (`4xx` → `400-499`) | yes |
| 3 | FAILED_STATE | `0` failed, `1` successful | yes |
| 6 | HTTP_METHOD | enum ordinal: GET 0, HEAD 1, POST 2, PUT 3, DELETE 4, TRACE 5, OPTIONS 6, CONNECT 7, PATCH 8 | yes (POST) |
| 9 | CALL_METHOD_ID (request/endpoint or SQL statement) | `SERVICE_METHOD-…` | yes |
| 10 | CALL_METHOD_GROUP_ID (request type; for "Requests to unmonitored hosts" this is the **target host**) | `SERVICE_METHOD_GROUP-… \x14 displayName` | yes |
| 26 | CALL_SERVICE_TYPE | ordinal: `0` database; `2` and `1` web request and web service. Several filters of this type are ORed: `26=2` plus `26=1` (the topweb preset) returned only WebRequest and WebService services, `26=0` (topdb) only database statements | yes |
| 29 | EXCEPTION | `0` any exception / class name | from preset |
| 30 | SERVICE_URL (web request URL contains) | text | yes |
| 50 | SERVICE_NAME | service display name; matches every service with that name | yes |

Other type IDs taken from the UI source, same encoding family, to be verified one by one during implementation: 1 CPU_TIME, 5 CALL_INSTANCE_ID, 7 CALL_TREE, 8 CALL_URI, 15 CALL_TAG (request attribute), 19 WAIT_TIME, 20 SYNC_TIME, 21 SUSPENSION_TIME, 22 CALLEE, 23 CALLER, 24 PROXY, 27 SERVICE_ID, 31 DATABASE_STATEMENT, 32 DATABASE_TABLE, 33 FLAWS, 34 DISK_IO_TIME, 35 NETWORK_IO_TIME, 37 NUMBER_OF_DB_CALLS, 38 NUMBER_OF_NON_DB_CALLS, 39 TIME_SPENT_IN_DB_CALLS, 40 TIME_SPENT_IN_NON_DB_CALLS, 41 TRACE_ID, 43 THREAD_NAME, 45 PROCESSING_TIME, 46 DATABASE_VENDOR, 47 DATABASE_NAME, 48 ENTITY_TAG, 52 PG_NAME, 53 PG_TAG, 54 DATABASE_ROW_COUNT, 55 DATABASE_FETCH_COUNT, 57 WEBREQUEST_HOSTNAME, 61 KEY_REQUEST, 62–65 release/build/stage/product, 67 SPAN_NAME, 68 SPAN_ATTRIBUTE, 70 ENTRY_POINT.

Type 57 (URL host) returned nothing for IP targets because Dynatrace masks them; use type 10 (host group id from the request list) for unmonitored hosts.

### 3.3 Trace statistics (multidimensional analysis)

`GET /rest/mda2` — aggregate any metric over traces, split by any dimension, with `servicefilter`.

- Params: `metric`, `dimension` (e.g. `{Request:Name}`), `percentile`, `timeseries` (must be present, `true` or `false`; the series are returned either way, 121 points per aggregate), `mergeServices`, `servicefilter`, `gtf`, `timeframe`. `aggregation` is not needed: every aggregate comes back in `totals`.
- `serviceId` is ignored. Scope to a service with the filter types 50 (service name) and, for a database service, 26 = 0; then keep the rows whose `serviceId` matches, because several services can share a name. Without a type 26 filter an environment-wide `{Request:Name}` query is dominated by SQL statements (79 of the top 100 in one check); `26=2` plus `26=1` restricts it to web requests and web services.
- Response: `analysisResult.dimensions[]` with `name`, `serviceId` (unless merged), `totals`, `timeseries`, `unreliableMetrics`, `uiMda2DimensionParts[]` (`id`, `name`, `placeHolder`; for `{Request:Name}` the id is the `SERVICE_METHOD-…`, for a request attribute it carries `value`). Time metrics (RESPONSE_TIME, CPU_TIME; unit µs): `AVERAGE, MEDIAN, P90, P95, CUSTOM_PERCENTILE, MIN, MAX, SUM, LOAD`. Count metrics (REQUEST_COUNT, FAILED_REQUEST_COUNT): `COUNT, COUNT_PER_MINUTE, LOAD, AVERAGE, MIN, MAX`. Also `unlimitedDimensionCount`, `omittedUnreliableDimensionsCount`, `displayNames` (service id → name), `serviceEntities` (service id → `serviceType`, `external`, `pgName`, …).
- At most 100 rows come back, those with the largest total (SUM, or COUNT for count metrics). Values with too few sampled requests are left out (`omittedUnreliableDimensionsCount`) or returned with `unreliableMetrics: true` and empty `totals`.
- `GET /rest/mda2/uiDefs?mdaId=topweb|topdb|exceptions|atm|topsql&initial=true` (404 without `initial`) lists what is available:
  - Metrics (35): RESPONSE_TIME, PROCESSING_TIME, CPU_TIME, IO_TIME, DISK_IO_TIME, NETWORK_IO_TIME, LOCK_TIME, WAIT_TIME, REQUEST_COUNT, FAILED_REQUEST_COUNT, SUCCESSFUL_REQUEST_COUNT, FAILURE_RATE, HTTP_4XX_ERROR_COUNT, HTTP_5XX_ERROR_COUNT, EXCEPTION_COUNT, DATABASE_CHILD_CALL_COUNT/TIME, NON_DATABASE_CHILD_CALL_COUNT/TIME, client-side variants, and each numeric request attribute.
  - Dimensions (73): Request:Name, Request:Type, Request:Failure, Relative-URL, URL:Host, HTTP-Method, HTTP-Status, HTTP-StatusClass, Exception:Class, Service:Name, Service:Instance, Service:Port, WebService:Endpoint/Method, release/build/stage/product, and every request attribute as `{RequestAttribute:<name>}` (e.g. `{RequestAttribute:CronJobName}`).

Cron jobs (SAP Commerce): the jobs are the requests of a custom service named `CronJobs` (`type("SERVICE"),entityName.equals("CronJobs")` returned four services of type CUSTOM_SERVICE, one per process group). Request names are the job code plus its PK, and equal the `CronJobName` request attribute. `GET /rest/services/servicecontributor?sci=<one of them>` lists the jobs of that service with executions, average, max and total time and failure rate; a job that runs on several nodes appears in several of the services, so `cron_job_statistics` reads all of them and merges by name. `/rest/mda2` with `dimension={RequestAttribute:CronJobName}`, `mergeServices=true` and the type 50 filter `CronJobs` gives the same ranking in one request, capped at 100 jobs and without failures. A run of 84 minutes was stored as one complete trace with its full response time; runs still in progress were not checked.

### 3.4 Service analysis

| Purpose | Endpoint | Response |
|---|---|---|
| Requests of a service with metrics; for "Requests to unmonitored hosts" the target hosts; for DB services the SQL statements | `GET /rest/services/servicecontributor?sci=` (+ `servicefilter` to drill in) | `topContributors[]` (id, name, metrics), service metadata |
| Failure analysis | `GET /rest/serviceanalysis/failure?sci=` | `data.reasons[]` (type, count, HTTP code, contribution, affected entities) |
| Response time hotspots | `GET /rest/serviceanalysis/responsetime?sci=` | breakdown by code / downstream |
| Response time distribution (outliers) | `GET /rest/serviceanalysis/responsetimedistribution?sci=` | histogram + failed histogram |
| Service flow (what it calls) | `GET /rest/serviceanalysis/serviceflow?sci=&serviceId=&analysisMode=RESPONSE_TIME` (`serviceId` is required) | downstream tree with contribution % |
| Backtrace (who calls it) | `GET /rest/serviceanalysis/servicebacktrace?sci=&serviceId=` | caller tree down to the calling request / cron job, with call counts |
| Method hotspots | `GET /rest/codelevelanalysis/methodhotspots/{serviceId or processGroupId}` | stack samples per method / API / thread state |
| Service lists | `POST /rest/services/new`, `POST /rest/services/databases/new` | UI list model; POST, so not usable through the GET-only bridge; the tools use `/rest/v2/entities` + metrics |
| Smartscape | `GET /rest/puremodel/horizontal/SERVICE` | topology graph |

All accept `servicefilter` and timeframe.

### 3.5 Database queries

- Slowest / most expensive statements: `/rest/mda2?metric=RESPONSE_TIME&dimension={Request:Name}` with the filters `26=0` and `50=<database service name>` (`serviceId` is ignored, see 3.3) → per statement total time, average, max, execution count, and the statement's `SERVICE_METHOD-…` id. Verified on live data: a frequently executed update statement ranked first by total time, and a select with a low average showed a max several hundred times higher.
- What causes a statement: `/rest/serviceanalysis/servicebacktrace?sci={dbService}&servicefilter=0\x1e9\x11{SERVICE_METHOD}` → calling services and the exact calling requests (verified: the callers resolved down to a named cron job in the CronJobs service and to requests of the other calling services).
- Slow executions of one statement: `/rest/purepaths/list` with `9=<statement>` plus `0=<min response time>`, then open the calling trace.

### 3.6 Pods, containers, processes, hosts

All through `/rest/v2` (stable):

- Workloads: `type(CLOUD_APPLICATION)`; pods: `type(CLOUD_APPLICATION_INSTANCE),fromRelationships.isInstanceOf(entityId(workload))` (the pod is the "from" side). Pod properties: `cloudApplicationInstancePhase`, `nodeName`, `internalIpAddresses`, `containerRestartCount`, `requestsCPU` / `limitsCPU`, `requestsMemory` / `limitsMemory`, `desiredContainersCount` / `runningContainersCount`, `namespaceName`, `workloadName`, labels, annotations.
- Containers: `type(CONTAINER_GROUP_INSTANCE)` (named `<pod> <container>`).
- Metrics: `builtin:containers.*` per container (cpu.usageMilliCores, cpu.usagePercent, cpu.throttledMilliCores, memory.residentSetBytes, memory.usagePercent, memory.limitBytes, memory.outOfMemoryKills); `builtin:kubernetes.workload.*` per workload (cpu_usage, memory_working_set, requests/limits, pods_desired, conditions); `builtin:kubernetes.container.restarts` / `oom_kills` per pod; `builtin:kubernetes.node.*`; process level `builtin:tech.nodejs.*` (v8heap.used/total/rss, uvLoop.utilization/loopLatency), `builtin:tech.jvm.*` (memory pools, GC time/suspension, threads), `builtin:tech.generic.*`.
- Pod events: `/rest/v2/events?entitySelector=…` (verified for one workload's pods: readiness probe failures, container stops, mount failures) and workload events ("Deployment spec change").

Internal detail endpoints (richer, one call each): `GET /rest/hosts/{id}` (process list, availability, events, timeseries), `GET /rest/processes/{pgiId}/processdetails` (callers/callees, services, events, JVM version, log files), `GET /rest/processes/processGroups/{id}` (+ `/timeseries?metricGroup=SYSTEM`), `POST /rest/processes/summary/new`, `GET /rest/newnetwork`. Of these the bridge allows the three GET detail endpoints of hosts, processes and process groups; it is GET-only.

### 3.7 Profiling

| Purpose | Endpoint |
|---|---|
| CPU by process group | `GET /rest/profiling/cpu/pgs` |
| Method hotspots (CPU, by API and thread state) | `GET /rest/codelevelanalysis/methodhotspots/{id}?showWaiting=` |
| Thread analysis | `GET /rest/codelevelanalysis/threadanalysis/{pgId}?showWaiting=` |
| Memory allocation hotspots | `GET /rest/codelevelanalysis/memoryallocation/{pgId}?survivorsOnly=` (the response can exceed 100 MB for a busy process group; the tool defaults to 15 minutes and asks for a shorter window when the bridge's size limit is hit) |
| Process crashes | `GET /rest/globalAnalysis/processCrash`, `…/globalAnalysisChart?eventType=PGI_CRASHED_INFO` |
| Memory dumps (list only) | `GET /rest/memoryDumps`, `…/pgis` — triggering a dump suspends the process; never exposed |

### 3.8 Problems

- `GET /rest/v2/problems` / `{id}`: evidence, impact, root cause entity, affected entities.
- `GET /rest/problems/{id}`: Davis root-cause findings (metric, event, availability), trigger event with baseline values, impact analysis.
- `GET /rest/problems/{id}/model`: visual resolution path (dependency chain).
- From a problem, the affected service + problem window feed straight into `analyze_failures`, `list_traces` (failed only) — verified on a closed problem.

### 3.9 Dashboards and charts

- `GET /rest/dashboards/list`, `GET /rest/dashboards/{id}` (tiles with type, name and position, but not their queries), `GET /rest/config/dashboards/{id}/tiles/{tileId}` (the configuration of one tile, including the Data Explorer metric selectors; on the allow-list), `GET /rest/startscreen/data/{TILE_TYPE}`, `POST /rest/dexp/execute` (Data Explorer queries), `GET /rest/dexp/entities-categories`. The bridge is GET-only, so tile queries are run through `GET /rest/v2/metrics/query` instead of `dexp/execute`.

### 3.10 Present but low value or empty in this tenant

Frontend/RUM (`/rest/uemapplications`), user sessions, synthetic (`/rest/syntheticmonitor/monitorloc`), VMware, Cloud Foundry, AWS/Azure/GCP lists, message queues (0 entities), releases (empty), SLOs (none), deployment status, hub, security (403). Not planned for v1; the generic entity/metric tools still reach whatever exists.

## 4. Graphs

Every chart in the UI is drawn from time-series JSON, so the bridge returns the data behind the graph rather than pixels:

- `metrics/query` with `resolution` → datapoints for any metric chart (service, pod, container, JVM, Node.js).
- `mda2` → per-dimension series for trace statistics.
- `purepaths/chart`, `responsetimedistribution`, method hotspot / thread state series.

Tool output for a series: min / max / avg / last, trend, the timestamps of peaks, and a compact downsampled table (e.g. 24 buckets). Charts are always returned as text series; there is no screenshot mode.

## 5. Architecture

Identical to kibana-bridge-mcp; reuse its code.

```
MCP client ──HTTP/SSE :47832──► MCP server (Node) ──WebSocket :47831──► extension ──fetch──► /e/{env}/rest/*
                                                                         (in the logged-in Dynatrace tab)
```

- **`server.js`** — MCP server (stdio + Streamable HTTP); loads the tools from `lib/tools/`. The WebSocket hub and request correlation are in `lib/bridge.js`, the `servicefilter` encoder in `lib/servicefilter.js`, the `nodeData` decoder and the response shaping in the tool files (`lib/tools/*.js`) with the shared helpers of `lib/format.js`.
- **`extension/background.js`** — WebSocket client, keepalive alarm, environment registry, tab routing, optional host permissions per environment.
- **`extension/content.js`** — ISOLATED world relay.
- **`extension/inject.js`** — MAIN world. Reads `window.csrf_token` per request, runs `fetch`, handles the 202 / `prgtkn` poll loop.
- **`extension/popup.*`, `badge.js`** — "Add this environment", header pill showing what the AI is querying.

Differences from kibana-mcp:

1. **Generic transport.** inject.js exposes one `DT_REQUEST {path, query, poll}` handler (GET only, no body); all endpoint knowledge lives on the server side in `lib/tools/`, so a new tool needs an extension update only when it needs a new route on the allow-list.
2. **Read-only by construction.** The allow-list is `lib/allowlist.js` (server, checked before sending) and `extension/allowlist.js` (extension background and inject.js), kept identical by the cases in `scripts/allowlist-cases.js`, which `npm run verify` checks: `GET` only, on exactly the routes the tools use. Every other method is refused, including the UI's read-style POSTs (`dexp/execute`, `entities/suggest`, `ua/list`, `ua/entity`, list models). Explicit deny-list: `apiTokens`, `credentials`, `memoryDumps` trigger, `settings` writes, anything `PUT`/`DELETE`.
3. **Environment detection** by `/e/{envId}/` + `window.csrf_token`; several environments (S1, P1, D1) registered by name and selectable per tool call.
4. **Session expiry** → clear "log in to Dynatrace again in the tab" error.
5. **Rate limiting.** One analysis request at a time per environment with a small delay; the cluster shows "Too many requests" when flooded.
6. **Response shaping.** Raw payloads run 100 KB – 2 MB. Convert µs → ms, collapse repeated SQL, truncate stack traces to top N frames (full on request), cap lists, drop cookie / authorization headers.

## 6. MCP tools

Discovery and metrics (stable, `/rest/v2`):

| Tool | Does |
|---|---|
| `list_services` | services by name / type with response time, failure rate, throughput |
| `find_entities` | generic entity selector search (hosts, pods, workloads, processes, queues…) |
| `get_entity` | properties, relationships, tags |
| `find_metrics` / `query_metrics` | search metric ids; run any metric selector, returned as summarized series |
| `service_overview` | p50/p90/p99, failures, throughput, related services, pods, open problems |
| `list_events` | events for any entity selector |

Kubernetes:

| Tool | Does |
|---|---|
| `list_workloads` / `list_pods` | workloads and their pods with phase, restarts, node, requests/limits |
| `pod_resources` | CPU, memory, throttling, OOM kills, restarts per pod and container over time |
| `pod_events` | Kubernetes events for a workload's pods (probe failures, kills, scheduling, deploys) |
| `process_runtime` | JVM heap/GC or Node.js heap/event-loop metrics for the processes in a pod |
| `get_host` / `get_process` | host or process detail (processes, callers/callees, events, availability) |

Traces:

| Tool | Does |
|---|---|
| `list_service_requests` | requests/endpoints of a service; target hosts for "Requests to unmonitored hosts"; statements for DB services |
| `cron_job_statistics` | cron jobs by total time, average, longest run, executions, failures, merged over the same-named services |
| `list_traces` | traces by service or whole environment, filtered by host group, request, URL, response time range, HTTP code, method, failed state, exception, request attribute, DB call count/time, trace id |
| `trace_statistics` | MDA: any metric × any dimension with the same filters (e.g. p95 response time per URL for one unmonitored host above 2 s); with `request_kind: "web"` the slowest / most time-consuming / most CPU / most failing endpoints across all services |
| `get_trace` | span tree with timings, SQL and downstream calls |
| `get_trace_details` | exceptions with stack traces, code-level tree, SQL statements, headers, pod |

Service analysis:

| Tool | Does |
|---|---|
| `analyze_failures` | failure reasons for a service and window |
| `analyze_response_time` | hotspots + distribution |
| `service_flow` / `service_backtrace` | downstream calls / upstream callers |
| `top_exceptions` | exception classes by count across services (MDA `exceptions`) |

Database:

| Tool | Does |
|---|---|
| `top_database_statements` | statements by total time, average, max, executions |
| `statement_callers` | which services / requests / cron jobs issue a statement |
| `slow_statement_executions` | slow executions of a statement with their calling traces |

Profiling:

| Tool | Does |
|---|---|
| `cpu_by_process_group` | CPU consumers |
| `method_hotspots` | CPU / wait hotspots by method for a service or process group |
| `thread_analysis` | thread groups by state and CPU |
| `memory_allocation_hotspots` | allocation hotspots |
| `list_process_crashes` | crashes in a window |

Problems:

| Tool | Does |
|---|---|
| `list_problems` | by status, window, entity |
| `get_problem` | evidence, Davis root cause, impact, events, dependency path |

Other:

| Tool | Does |
|---|---|
| `list_dashboards` / `get_dashboard` | dashboard tiles and their queries |
| `read_settings` | read a settings schema's values (request attributes, anomaly detection, alerting) |
| `dynatrace_bridge_status` | connection, environments, extension version |

Every result carries a deep link to the matching UI page.

## 7. Phases

1. **Scaffold** — copy kibana-mcp's server/extension skeleton, new ports, generic `DT_REQUEST` transport with CSRF, poll loop, allow-list and rate limit, environment registration, status tool.
2. **Stable tools** — entities, metrics, problems, events, Kubernetes tools. Usable on their own.
3. **Traces** — `servicefilter` encoder, `list_service_requests`, `list_traces`, `trace_statistics`, `get_trace`, `get_trace_details`.
4. **Service + database analysis** — failures, response time, flow, backtrace, top statements, statement callers.
5. **Profiling, problem deep-dive, dashboards, settings.**
6. **Polish** — verify remaining filter type IDs, header pill, installer, README, npm publish, CI (reuse kibana-mcp's verify script, workflows, version sync).

## 8. Risks and open items

- Sections 3.x are undocumented and can change with a cluster upgrade. Keep each behind a small adapter with shape checks and a clear "Dynatrace changed" error. `/rest/v2` tools are unaffected.
- Only verified on Dynatrace Managed classic UI 1.346. Dynatrace SaaS latest (Grail) uses different APIs; out of scope for v1.
- The unmonitored-host + response-time flow was verified on one target host only; re-check it on another environment and host.
- `servicefilter` types not marked "verified" need one live check each; `nodeData` columns 11, 13, 16, 19, 20, 22–26 are unidentified.
- Trace retention and sampling limit history; surface `onlyPartialTimeframeCovered` / `sampleRate`.
- Trace payloads contain URLs and headers; Dynatrace masks most values, the server still strips auth/cookie headers.
- The session can write (settings, memory dumps, tokens). The allow-list (`lib/allowlist.js` + `extension/allowlist.js`) is the safety boundary; `npm run verify` checks both implementations against `scripts/allowlist-cases.js`.
- Using the UI session against internal endpoints may be outside what the tenant operator (SAP) intends; keep volume low and read-only.
