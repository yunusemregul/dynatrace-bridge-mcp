# How to inspect Dynatrace for a new tool

This is the method used to produce `PLAN.md`. Follow it when a new tool is needed and the endpoint behind a UI page is unknown. It assumes Claude Code with the Claude in Chrome tools and a Chrome profile already logged in to the Dynatrace environment.

Goal of an inspection: for one UI page or feature, find the `/rest/...` request(s) that feed it, the parameters, the response shape, and prove the request can be replayed with a plain `fetch` from the page.

## Rules

- **Read-only.** Only issue GETs, and the read-style POSTs the UI itself sends when a page loads. (That is for inspecting by hand; the bridge is GET-only, so an endpoint that needs POST cannot become a tool.) Never click Trigger / Save / Delete / Create controls. Never call `apiTokens`, `credentials`, or the memory dump trigger.
- **Never print secrets.** Do not output `window.csrf_token`, cookies, or header values. Check where a value lives by comparing in-page and printing only the location.
- **Go easy on the cluster.** Analysis endpoints are expensive. Run them one at a time. Do not brute-force parameters in a loop (46 trace-list calls in a few seconds was a mistake during the first inspection).
- Work in the tab from `tabs_context_mcp`; do not touch the user's other tabs.

## What you need to know first

- Base path: `/e/{environmentId}`. All API calls are `{base}/rest/...`.
- Auth for `fetch`: header `X-CSRFToken: window.csrf_token` plus `Accept: application/json; charset=utf-8`. Without the token the server answers `499`.
- Slow endpoints answer `202 {token}`; repeat the same URL with `&prgtkn={token}` until `200`.
- Two UI generations: Angular pages at `/ui/...` and GWT pages at `/#...`. Moving between them is a full page load and wipes anything injected. Inside one generation, navigation is client-side and injected hooks survive.
  - GWT: change `location.hash` to move between pages.
  - Angular: click the sidebar `<a>` elements; `history.back()` works.
- `/rest/v2/*` mirrors the documented public API. Before reverse-engineering anything, check whether the public API already covers it: the OpenAPI specs are at `{base}/rest/v2/rest-api-docs/v2/spec3.json`, `.../v1/spec3.json`, `.../config/v1/spec3.json` (fetch with the CSRF header).

## Tool quirks that cost time

- **Output filter.** The JavaScript tool blocks results that look like query strings, cookies, base64 or JWTs (`[BLOCKED: ...]`). Before returning strings: replace `= ; ? & %` with spaces, replace runs of 36+ alphanumerics with `LONG`, print URL paths with `' / '` instead of `/`, and avoid result keys named `token`. Dotted identifiers like `dt.entity.service` can also trip it; print them with spaces around the dots.
- **Control characters.** The `servicefilter` value contains `\x10 \x11 \x14 \x1e`. Print them escaped (`<1e>`), otherwise they are invisible.
- **45 s limit.** One `javascript_exec` call times out after about 45 s. For longer loops, start an async function that writes to `window.__survey` and sets `window.__surveyDone`, return immediately, then poll in a second call.
- **Do not sleep across a navigation** in one call; the evaluation is killed ("Inspected target navigated or closed"). Navigate, then start a new call.
- **`read_network_requests`** only starts recording when first called and gives no bodies. `performance.getEntriesByType('resource')` is better for "what did this page load" (URLs only), and the XHR hook below is better for everything else.
- **CSP.** Angular pages block `eval` and inline scripts; GWT pages allow inline scripts but not `eval`. Code passed directly to `javascript_exec` always runs. So helpers cannot be re-loaded from `sessionStorage` on Angular pages; paste them into the call again after each full page load.
- **Screenshots** are only needed to find a control to click. Everything else is faster through JS.

## Helpers

Paste this at the start of a `javascript_exec` call after every full page load. It installs an XHR recorder and a few utilities on `window`.

```js
(() => {
  const base = location.pathname.match(/^\/e\/[^/]+/)[0];
  if (!window.__cap) {
    window.__cap = [];
    const o = XMLHttpRequest.prototype.open, d = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__r = { m, u: String(u) }; return o.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      if (this.__r) {
        this.__r.b = typeof b === 'string' ? b : null;
        window.__cap.push(this.__r);
        this.addEventListener('load', () => {
          this.__r.st = this.status;
          try { this.__r.resp = this.responseType === '' || this.responseType === 'text' ? String(this.responseText) : JSON.stringify(this.response); } catch (e) { this.__r.resp = ''; }
        });
      }
      return d.apply(this, arguments);
    };
  }
  window.__san = s => String(s).replace(/[=;?&%]/g, ' ').replace(/[A-Za-z0-9+\/_-]{36,}/g, 'LONG');
  window.__esc = s => String(s).replace(/[\x00-\x1f]/g, c => '<' + c.charCodeAt(0).toString(16).padStart(2, '0') + '>');
  const skip = /usersettings|notifications|trialinfo|about\/status|language|displaynames|clientlogging|\/rest\/navigation|serviceheader|icons|settings2\/navigation|remote_logging/;

  // Recorded calls since the last `window.__cap.length = 0`, deduplicated, with params, body and status.
  window.__brief = (vl = 50, bl = 220) => {
    const seen = new Map();
    for (const r of window.__cap) {
      const u = new URL(r.u, location.origin);
      const p = u.pathname.replace(base, '');
      if (!p.startsWith('/rest') || skip.test(p) || r.st === 202) continue;
      const pk = p.replace(/[A-Z_]+-[0-9A-F]{16}/g, '{ID}').replace(/-?\d{10,}[_0-9V]*/g, '{N}').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{UUID}');
      const key = r.m + pk + [...u.searchParams.keys()].filter(k => k !== 'prgtkn').join();
      if (seen.has(key)) { seen.get(key).n++; continue; }
      seen.set(key, { n: 1, line: r.m + ' ' + window.__san(pk).split('/').join(' / ') + ' ['
        + [...u.searchParams.entries()].filter(([k]) => k !== 'prgtkn').map(([k, v]) => k + ':' + window.__san(window.__esc(v)).slice(0, vl)).join(' , ') + ']'
        + (r.b ? ' BODY ' + window.__san(r.b).slice(0, bl) : '') + ' -> ' + r.st + ' ' + (r.resp || '').length });
    }
    return [...seen.values()].map(x => x.line + (x.n > 1 ? ' (x' + x.n + ')' : ''));
  };

  // What the current document loaded before the hook existed (URLs only, no bodies).
  window.__perf = () => [...new Set(performance.getEntriesByType('resource')
    .filter(e => ['xmlhttprequest', 'fetch'].includes(e.initiatorType) && e.name.includes('/rest/') && !skip.test(e.name))
    .map(e => { const u = new URL(e.name); return window.__san(u.pathname.replace(base, '').replace(/[A-Z_]+-[0-9A-F]{16}/g, '{ID}')).split('/').join(' / ')
      + ' [' + [...u.searchParams.entries()].filter(([k]) => k !== 'prgtkn').map(([k, v]) => k + ':' + window.__san(window.__esc(v)).slice(0, 50)).join(' , ') + ']'; }))];

  // Replay a request with the session, following the 202 / prgtkn loop.
  window.__poll = async (p, opt = {}) => {
    const H = { Accept: 'application/json; charset=utf-8', 'Content-Type': 'application/json; charset=utf-8', 'X-CSRFToken': window.csrf_token };
    let url = base + p;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(url, { headers: H, ...opt });
      const t = await r.text();
      if (r.status !== 202) { let j = null; try { j = JSON.parse(t); } catch (e) {} return { st: r.status, len: t.length, polls: i, j, t: j ? undefined : t.slice(0, 300) }; }
      url = base + p + (p.includes('?') ? '&' : '?') + 'prgtkn=' + JSON.parse(t).token;
      await new Promise(r => setTimeout(r, 800));
    }
    return { st: 'timeout' };
  };

  // Compact shape of a JSON value: one line per object / array of objects, listing keys.
  window.__struct = (o, max = 40, depth = 5) => {
    const acc = [];
    const walk = (o, p, d) => {
      if (d > depth || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) { if (o.length && o[0] && typeof o[0] === 'object') { acc.push(p + '[] x' + o.length + ': ' + Object.keys(o[0]).slice(0, 28).join(', ')); walk(o[0], p + '[]', d + 1); } return; }
      for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object' && !Array.isArray(v)) acc.push(p + '.' + k + ': ' + Object.keys(v).slice(0, 28).join(', ')); walk(v, p + '.' + k, d + 1); }
    };
    walk(o, '$', 0);
    return acc.slice(0, max).map(window.__san);
  };
  return 'helpers ready';
})()
```

## Procedure

1. **Open the page** that shows the data you want (`navigate`), wait for it to load, install the helpers, and run `window.__perf()` to see what the initial load called.
2. **Capture interactions.** Set `window.__cap.length = 0`, perform the click / tab switch / hash change, wait 4–6 s, then `window.__brief()`. Each line is `METHOD path [params] BODY -> status size`. Repeat for every tab and drill-down on the page (for the trace page: Summary, Timing, Threads, Code level, Logs, Errors).
3. **Replay with `window.__poll`.** Rebuild the URL from the captured params and call it yourself. If it returns the same data, the bridge can use it. If it fails, compare with the captured request: missing param, POST instead of GET (list models such as `/rest/services/new` are POST with a filter body), or wrong timeframe format.
4. **Read the shape.** `window.__struct(result.j)` for structure, then print a few real values from the fields that matter (sanitized). Note units; timings are microseconds.
5. **Test the parameters you will expose.** Change the timeframe to a custom past window, change the entity id, add a filter, and check the result changes the way you expect (for filters: check min/max of the returned rows, not just the count).
6. **Write it down** in `PLAN.md`: purpose, method and path, key params, response fields, what was verified and what was only observed.

## Decoding opaque parameters

When a parameter is not self-explanatory (the `servicefilter` case):

1. Produce a few examples by using the UI filter and reading the resulting value from the page URL or the captured request, printed with `window.__esc`.
2. Read the UI source. Fetch the Angular bundle (`[...document.scripts].map(s => s.src)` → `main.*.js`, about 6 MB) and search it as text for the parameter name and for nearby constants. Useful finds from the first inspection:
   - separators: search `SERVICE_FILTER_PARAM` → `VERSION_SEP`, `TYPE_SEP`, `FILTER_SEP`, `FIELDS_SEP`;
   - filter type ids: the enum listing `h.RESPONSE_TIME="RESPONSE_TIME", h.CPU_TIME=...`; the position in that list is the numeric id;
   - value formats: search `get type(){return e.YK.<NAME>}` and read the surrounding class;
   - route names: search for the quoted route token (`"methodhotspots"`, `"threadanalysis"`) to find the link builder and its query params.
   Minified identifiers (`e.YK`, `h.`) change between versions; search by the string constants.
3. Confirm each decoded piece with one real request.

Saved MDA presets are another source of examples: `/rest/mda2/uiDefs?mdaId=topweb|topdb|exceptions` returns the preset's `serviceFilter`.

## Finding pages and routes

- Sidebar links: `[...document.querySelectorAll('a[href]')]` gives every menu route.
- Drill-down links on a page (e.g. a service page) reveal the GWT hash routes and their parameters: `#smgd;sci=`, `#failureanalysis;sci=;timeframe=`, `#responsetimeanalysis`, `#responsetimedistribution`, `#serviceflow`, `#servicebacktrace`, `#trace;traceId=;callURI=`, `#methodhotspots;entityId=`, `#problems/problemdetails;pid=`, `#vres;pid=`, `#newhosts/hostdetails;id=`, `#processdetails;id=`, `#processgroupdetails;id=`, `#processcrashesglobal`.
- Angular routes: `ui/services`, `ui/entity/{id}`, `ui/entity/list/{TYPE}`, `ui/services/{id}/purepaths`, `ui/diagnostictools/purepaths`, `ui/diagnostictools/mda?mdaId=`, `ui/diagnostictools/profiling/cpu`, `ui/diagnostictools/{pgId}/threadanalysis`, `ui/diagnostictools/{pgId}/memoryallocation`, `ui/diagnostictools/memorydumps`, `ui/problems`, `ui/databases`.
- Entity ids to test with come from `/rest/v2/entities?entitySelector=type(...)`.

## Surveying many pages at once

GWT pages, in one document:

```js
window.__survey = {}; window.__surveyDone = false;
(async () => {
  for (const h of ['newprocessessummary', 'smartscape', 'uemapplications']) {
    window.__cap.length = 0;
    location.hash = '#' + h + ';gtf=-2h;gf=all';
    await new Promise(r => setTimeout(r, 5500));
    window.__survey[h] = { title: document.title.split(' - ')[0], calls: window.__brief() };
  }
  window.__surveyDone = true;
})();
'started'
```

Then in the next call: wait for `window.__surveyDone` and return `window.__survey`. For Angular pages do the same but click the sidebar link whose `href` matches instead of setting the hash.

## Adding the tool afterwards

1. If the route is new, confirm it is a read-only GET and add it to the allow-list: `lib/allowlist.js`, `extension/allowlist.js` and a case in `scripts/allowlist-cases.js` (`npm run verify` checks that all three agree and that every route is used by a tool). POST routes cannot be added.
2. Add the tool in `lib/tools/<group>.js` (contract in `ARCHITECTURE.md`): build the request (timeframe translation, `servicefilter` encoding), check the response shape, reduce it (µs → ms, cap lists, truncate stack traces, strip auth/cookie headers).
3. Register the MCP tool with a deep link to the UI page in its output.
4. Record the endpoint and what was verified in `PLAN.md`.
