# Reconstructing X.com's new web app: Fastify + React streaming + Relay

A working reconstruction of the server architecture described in
"Rebuilding the global town square from scratch" (X Engineering, Nov 2026).
X's code is not public. Everything here is rebuilt from the post and verified
by running it.

Each claim is tagged:

- **[post]**: stated in the article.
- **[inferred]**: the reconstruction's choice where the post is silent.
- **[found]**: a non-obvious behaviour hit while building this. These are the
  most useful parts.

File paths are relative to `apps/web` unless they start with `apps/` or
`packages/`. The repo is a pnpm + Turborepo workspace; see the README for the
layout.

## 1. Request lifecycle

```
                   edge (CDN)                                Fastify worker (Watt)
 browser/bot ──▶ verify crawler by IP ──▶ x-edge-verified-bot ──▶ audienceOf()
                 match ngroutes.json      (stripped from clients)      │
                 feature switch          else ─▶ rweb                  ▼
                                                     Promise.all(guest token, feature flags)
                                                                       │
                                                           render(): matchRoute()
                                                                       │
                                                  loadRoute(): start ALL GraphQL requests
                                                                       │
                                               await primary query + page chunk (status, <head>)
                                                                       │
            ┌───────────────────────────┬─────────────────────────────┴──────────────┐
            ▼                           ▼                                            ▼
   person: onShellReady         crawler: onAllReady                         preview: onAllReady
   stream shell, Suspense       one document, boundaries                    <head> only; body
   boundaries + responses       in place, no JS/data                        queries never sent
   interleaved by injector
```

## 2. Edge contract: who is asking

`server/app.ts` → `audienceOf()`

- **[post]** Crawlers are verified by the edge **by IP, not User-Agent**. This
  has two effects. Lighthouse (Googlebot-like UA, unverified IP) measures the
  same streamed page people get. And nobody can opt into the expensive buffered
  path by setting a header.
- **[post]** An unverified "Googlebot" is treated exactly like a logged-out
  person.
- **[inferred]** The edge passes its verdict in a header that it strips from
  client requests (`x-edge-verified-bot: search|preview`). The app never looks
  at User-Agent.
- **[post]** Routing is per path and per visitor. `scripts/ngroutes.ts` walks
  the file-based route tree and emits `dist/ngroutes.json` on every build. The
  edge sends a path to the new app only if it is listed there and the feature
  switch includes the visitor; everything else goes to rweb. In the prototype,
  an unknown path returns 404 with "edge would send this to rweb".

## 3. Server assembly (`@x-clients/server` analogue)

`packages/server` (`@x-ssr/server`) → `createServer()`, plus
`apps/web/server/app.ts` → `create()`

- **[post]** Fastify handles every request. The app is assembled from
  configuration: security headers, cookies, metrics, streaming rendering, and
  graceful shutdown.
- **[post]** X keeps that assembly in a shared package of its own,
  `@x-clients/server`. Here it is `@x-ssr/server`, which knows nothing about
  routes, audiences or upstreams. It provides:
  - Fastify with security headers and `/metrics` counters;
  - production SSR loading: the built entry, `/assets` served immutable and
    precompressed, and asset resolution from the Vite manifest;
  - dev SSR loading (see §12);
  - `sendHtml()` with `Server-Timing`;
  - `parseCookies()`;
  - `listen()` with graceful shutdown.

  The web app's `server/app.ts` adds only what is specific to it: the edge
  contract (`audienceOf()`), guest token and feature flags, the GraphQL
  endpoint, URL cleanup, and the render route.
- **[post]** Platformatic Watt runs the app as several worker threads in one
  process, and replaces any worker whose event loop or memory stays over its
  limit. Watt's contract is simple: export `create()` returning a Fastify
  instance, and Watt calls `ready()`/`listen` itself (`@platformatic/node`
  `capability.js`). `watt.json`:
  - `"workers": 4`
  - `health.maxELU: 0.95`, `health.maxHeapUsed: 0.9`
  - `maxUnhealthyChecks: 10` at `interval: 1000` (the "stays over" part)
- **[post]** Logged out, the guest-token and feature-flag requests start
  together (`Promise.all`). The flags request doesn't use the token, so waiting
  on the token first was a serial round trip for nothing.
- **[post]** Event-loop starvation turns into false timeouts. Under load a
  stalled loop can fire a 1s timer before it handles a response that already
  arrived. X saw 1–9% of renders time out against a ~25 ms upstream. Their fix
  was more workers (lower event-loop utilisation per worker), not longer
  timeouts. The API client (`apps/web/server/api-client.ts`) carries the note.
- **[found]** When an upstream times out _after_ the shell has been sent,
  React marks that boundary as client-rendered (error #419). The browser then
  fetches the data itself through the replay network's API fallback. The
  verification run hit this by accident (5 s upstream, 1 s timeout), and the
  page still completed. Degradation works, but it shows up as a console error,
  which matters for "no errors" dashboards.

## 4. Routes and loaders

`src/router/*`, `src/routes/**/loader.ts`

- **[post]** Routes are file-based. Each one declares its data up front, and
  route loaders start the GraphQL requests while the server is still rendering.
- **[inferred]** A loader has three parts:
  - `primary`: awaited before the first byte. It decides the **status code**
    (real 404s) and `<head>`.
  - `body`: streamed behind Suspense.
  - `head(data)`: pure; title, description, canonical, language alternates,
    Open Graph, and JSON-LD.
- Loaders are imported eagerly (tiny: query artifacts plus a function). Pages
  are lazy chunks (`page-chunks.ts`).
- The same `loadRoute()` runs in three places:
  1. On the server, to start the fetches.
  2. In the browser at hydration, where the network replays the server's
     responses.
  3. On intent-to-navigate preloads.
- **[post]** TTFB is higher than rweb (430–560 ms vs. under 300 ms signed in),
  because the server fetches the data and renders before it answers. Awaiting
  `primary` is that cost. The prototype logs it as
  `server-timing: upstream;dur=…, shell;dur=…`.

## 5. Rendering by audience

`src/entry-server.tsx`

| Audience         | React callback | What is sent                                                                                                        |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| person           | `onShellReady` | Shell first, then each Suspense boundary plus its GraphQL responses as they resolve                                 |
| verified crawler | `onAllReady`   | One finished document: JSON-LD, no client bundle, no router state, no data scripts, no skeletons or sign-in buttons |
| link-preview bot | `onAllReady`   | `<head>` only. `loadRoute(..., { headOnly: true })` never sends the timeline/conversation queries                   |

- **[found] `onAllReady` alone does not give an "every boundary resolved in
  place" document.** React 19 still **outlines** a completed boundary
  (`<div hidden id="S:0">`, `<template>`, plus an `$RC` script) when
  `flushedByteSize + boundary.byteSize > progressiveChunkSize` (12,800 bytes by
  default; `react-dom-server.node.production.js`, `flushSegment`).
  - A 20-post timeline (~20 KB) crossed that line, so the crawler document
    depended on JS to put the posts in place.
  - Fix: `progressiveChunkSize: Infinity` for bots. After the fix the crawler
    `/ada` document has 1 script (JSON-LD) and 20 inline posts.
- **[post]** Crawler documents must stay under Googlebot's 2 MB read limit. The
  prototype applies the post's three reductions in miniature:
  - **SVG sprite.** `IconSprite` sits once at the top of the page; posts use
    `<use href>`. This replaced ~2 KB of inline icons per post: 14% on a
    profile, 13.6% on a long thread.
  - **Lean `ImageObject`.** One URL per photo, described by its own alt text
    only.
  - **No JS-only output.** Crawler documents drop relative-timestamp hooks and
    the signup banner (`Timestamp`, `SignupBanner`).

## 6. Relay data transport: the core trick

`src/relay/server.ts`, `src/ssr/inject.ts`, `src/relay/client.ts`,
`src/app/boot-scripts.ts`

### Server

- **[post]** Each GraphQL response the server received goes into the page
  **once, as JSON text**. The normalized Relay store is _not_ serialized: at
  X those records were 4–5× the size of the responses.
- Measured here (same queries, raw responses vs. the serialized store after
  they settle): `/ada` 6,270 vs. 7,360 bytes (1.17×), `/ada/status/1001`
  5,210 vs. 6,305 bytes (1.21×); gzipped the gap widens to ~1.6×. The mock
  posts are long text, so per-record overhead (`__id`, `__typename`, `__ref`)
  is a small share. Restoring a serialized store was faster than replaying
  (52–72 µs vs. 322–364 µs). Size is not the main reason here: the store
  format is relay-runtime internals, so server and browser would have to run
  the same version, and a whole store cannot stream per boundary.
- One Relay `Environment` per request (`isServer: true`). Its network
  `fetchFn` hands the raw response text to the injector.

### Injector: where data can be spliced into the stream

- **[found]** React's Node writer emits fixed-size views, so a `write()` can
  end in the middle of a tag. The only safe splice points are where React calls
  `destination.flush()`. It calls that at the end of every flush cycle:
  `completeWriting(); flushBuffered()` → `destination.flush()`. That covers the
  shell, each completed boundary, and the final `</body></html>`.
- `ResponseInjector` is a `Transform`. React's bytes pass straight through;
  only our data scripts wait for a flush point:
  - **The shell:** data that arrived before the shell goes after it. Nothing
    may precede `<!DOCTYPE html>`.
  - **Later cycles:** data that arrived between cycles goes right before the
    next cycle's first byte, which is before the boundary that renders it. The
    response is therefore in the DOM before React reveals and hydrates that
    boundary. Data that arrives during a cycle goes at the cycle's end.
- **[found]** When the shell _is_ the whole document (no pending boundaries,
  e.g. a 404 profile), the first flush already ends with `</body></html>`.
  Appending data there put scripts after `</html>`. The injector always holds
  back the last 14 bytes of a cycle, so at a flush point the data can still
  go before `</body></html>`.
- **[found] Backpressure.** The first version buffered React's bytes and
  pushed them only at flush points. Transform's backpressure check skips any
  write that produced no output, so React was never told to pause: a reader
  that stopped reading still had the whole page (1.54 MB in the test)
  written into memory. Passing React's bytes through restores the native
  mechanism: `write()` returns `false`, React pauses at the next boundary and
  resumes on `'drain'`. `ssr/backpressure.test.ts` renders 300 boundaries
  into a stalled reader and asserts React stops early, then that the full
  page arrives once the reader catches up. The compression stream already
  propagated backpressure, because it pushes before acknowledging; a test
  covers it too.
- Escaping: `<` becomes `\u003c` (still valid JSON), and U+2028/2029 are
  escaped. The mock data contains `</script><b>` to prove this works.

### Wire format

```html
<script type="application/json" data-rr="ProfileTimelineQuery:{&quot;screenName&quot;:&quot;ada&quot;}">{"data":…}</script>
<script>__rr.p()</script>
```

- The response key is `operationName + stable-stringified variables`, the same
  on both sides.
- `__rr.p()` is a ~300-byte inline registry in `<head>`. It moves the text into
  a Map, removes both script nodes (React never sees them during hydration),
  and wakes anyone waiting on that key.

### Browser

The client network has three paths:

1. **Response already streamed:** `JSON.parse` it and replay it into an empty
   store (**[post]** "parses it with JSON.parse when it replays").
2. **Stream still open:** wait for the key. The server is fetching it, so
   asking the API would be a duplicate request.
3. **Stream ended (`DOMContentLoaded`) and no response:** fetch from
   `/i/api/graphql`.

**[post]** Unread responses are kept for 30 s after the stream ends, so a tab
or dialog opened right after still finds them.

## 7. Boot: stylesheet first, async entry

`src/app/boot-scripts.ts` → `stylesheetFirstLoader()`, `src/entries/*`

- **[post]** On slow links, JS downloads competed for bandwidth with the
  render-blocking CSS. A small inline script now waits for the stylesheet's
  `load` event, then adds the modulepreloads for the chunks the server rendered
  (from the Vite manifest; `assets()` in `@x-ssr/server`) and the entry script.
- **[post]** The entry is an **async** module, not deferred. A deferred module
  waits until the whole streamed document is parsed, which means waiting for
  the slowest Suspense boundary. An async module runs on arrival; React
  hydrates the shell, and each boundary hydrates when its HTML lands.
- **[post]** Logged-out and signed-in visitors get separate entry points
  (`logged-out.tsx`, `signed-in.tsx`).
- **[inferred]** `hydrateRoot(document, …)`: the whole `<html>` is React's.
  Feature flags travel in `#app-data`, so the browser renders exactly what the
  server rendered.

## 8. Navigation and intent preloading

`src/app/App.tsx` → `prepare()`, `src/components/Link.tsx`,
`src/components/PostCard.tsx`

- **[post]** Links preload a route's code **and** data on hover or focus.
  `prepare()` calls `route.page()` and `loadRoute()` together and caches the
  result for 30 s; the click reuses it.
- **[post]** Posts aren't links. They preload after the pointer **moves** onto
  the post and rests for 100 ms, or on press. A post that scrolls under a still
  pointer gets no `pointermove`, so it doesn't preload (verified, B1).
- **[post]** Signed-in Home renders only in the browser, in both apps. That is
  why it gains least (1.7× on Slow 4G).

## 9. Startup chunking

`vite.config.ts` → `output.codeSplitting.groups` (Rolldown via Vite 8)

- **[post]** Rolldown's default chunking produced 754 startup files signed in
  and 582 logged out. At ~100 concurrent HTTP/2 streams that was about 8 round
  trips. X packs everything an entry loads at startup into three chunks:
  - dependencies;
  - their own code;
  - the code that names lazy chunks (it changes every deploy, so it is
    isolated to keep the other two cacheable).
- The reconstruction decides membership with `ctx.getModuleInfo()`: a module
  belongs to a group if a chain of **static** importers reaches an entry. In
  this build, `startup-deps` kept the same hash across app-code changes.
- **[found]** Three pitfalls, each of which broke the build:
  1. `includeDependenciesRecursively` defaults to `true`. The "names" group
     dragged in all its imports, including React and Relay (285 KB instead of
     0.9 KB).
  2. **Chunk cycle.** The route table imported the loaders (app code) _and_
     named the lazy pages. That put a static `startup-app ⇄ startup-names`
     cycle in the bundle, which crashed at runtime
     (`Cannot read properties of undefined (reading 'default')`). The module
     that names lazy chunks must contain _only_ dynamic imports
     (`router/page-chunks.ts`).
  3. **Entry modules must stay out of shared groups.** Captured into
     `startup-app`, both entries' top-level code ran in every entry. Both
     `boot(false)` and `boot(true)` hydrated the same document, which produced
     React #418, duplicate API calls, and the wrong route on `/home`.

## 10. Verification

These were run against the production build.

### `scripts/probe.ts`: chunk arrival timing

| Request                    | Result                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| person `/ada`              | 193 ms: shell (3.8 KB) plus the header query response. 641 ms: timeline response, then the boundary (27.5 KB) |
| crawler `/ada`             | 644 ms: one 22 KB document, 1 script (JSON-LD), 20 posts inline                                               |
| crawler `/nobody`          | HTTP 404, complete document                                                                                   |
| preview `/ada/status/1001` | 1.3 KB, `<head>` only, ~200 ms (the 650 ms conversation query is skipped)                                     |

### `scripts/browser-check.mjs`: Chromium (Playwright 1.65) in a sibling container

16/16 checks pass:

- **A. Logged-out profile load**
  - Hydrates with no console or page errors.
  - **0 GraphQL requests at load.**
  - Data scripts are removed from the DOM.
  - The first JS request starts after the CSS `responseEnd`.
- **B. Intent preloading**
  - A post scrolling under a still pointer is not preloaded.
  - A 100 ms dwell preloads `PostQuery` and `ConversationQuery`.
- **C. Click navigation**
  - Client-side; reuses the preload with 0 extra requests; title updated.
- **D. Slow 4G (150 ms / 1.6 Mbps) with a 5 s conversation upstream**
  - **Shell hydrated at 1,243 ms; document finished parsing at 5,322 ms.** The
    post reports 589 ms vs. 6,017 ms for the same experiment.
  - 0 API requests; no errors.
- **E. Signed-in `/home`**
  - Uses the signed-in entry; client-only render; fetched via the API; no
    errors.

### Platformatic Watt

`wattpm start` runs 4 workers. `/metrics` returns different per-worker
counters, which shows that requests are spread across worker threads.

## 11. SEO parity against the old servers

`packages/seo-parity`, `apps/legacy-ssr`, `packages/url-cleanup`

- **[post]** The old SSR servers were treated as specifications. A small parity
  script requests the same path from two servers as a verified Googlebot and
  compares what search engines read:
  - status code and redirect;
  - title, description, canonical URL;
  - robots tags;
  - Open Graph and X card tags;
  - number of language alternates;
  - structured-data types.
- **How the script works:**
  - Each response is flattened into `field → normalised value`, using
    htmlparser2 (entities decoded, whitespace squashed, robots tokens sorted,
    JSON-LD `@type` collected recursively).
  - The two maps are compared over the union of their keys, so missing, extra
    and changed fields all go through the same code.
  - If either side redirects, only status and target are compared.
  - Redirect targets are compared as paths, so the two hosts don't matter.
  - Exit code 1 on any difference, so it can gate CI.
- **[inferred]** `apps/legacy-ssr` stands in for rweb SSR / Jetfuel SSR. It reads
  the same data with a hand-written template (single quotes, different
  attribute order, unquoted attributes), so any false positive from markup
  would show up. It deliberately keeps four behaviours the new app lacked.
- **Workflow, as in the post:**
  1. Run the script and get the gaps.
  2. Port each behaviour next to a comment naming the server it came from.
  3. Run again until it is clean.
- **Results:**
  - **Baselines** (each server compared with itself): 11/11 match. The
    normalisation produces no false positives.
  - **First run:** 11/11 paths differed, and every difference was one of the
    four seeded gaps:
    - `meta:og:type` (×8);
    - `alternates` 4 vs. 3 (×11), missing `x-default`;
    - `robots:robots` `noindex` on 404s (×2);
    - `status`/`location` 301 vs. 404 on `/ada.`, `/ada。` and
      `/ada/status/1001!` (rweb SSR's trailing-punctuation cleanup).
  - **Fixes:**
    - `ogType` in `HeadData` and in each loader;
    - `x-default` and 404 `noindex` in `Document`;
    - `cleanPath()` ported into `packages/url-cleanup`, which issues a 301
      before render and keeps the query string.
  - **Second run:** 11/11 match. The browser checks still pass 16/16.

## 12. Development mode

`packages/server/src/development.ts` → `developmentMode()`

- **[inferred]** One Fastify server serves both modes, so dev exercises the
  same streaming, audience and replay code as production. In dev:
  - Vite runs in middleware mode (`@fastify/middie`), with the HMR websocket
    on Fastify's HTTP server.
  - `ssrLoadModule('/src/entry-server.tsx')` runs on every request.
  - The loader script points at `/__dev/entry/<name>.js`, a small module that
    installs Vite's client and the React Refresh preamble (taken from
    `vite.transformIndexHtml`), then imports the real entry.
- **[found]** Relay's TypeScript artifacts import `ConcreteRequest` with a
  plain `import`. With `verbatimModuleSyntax`, Vite's dev SSR keeps it, and
  Node's ESM loader rejects the named import from the CommonJS
  `relay-runtime`. The production bundle hid this, because Rolldown's CJS
  interop just yields `undefined`. Fix: `"useImportTypeSyntax": true` in
  `relay.config.json`.
- **[found]** `node --watch` follows every imported file, including the
  temporary `vite.config.ts.timestamp-*.mjs` bundle that Vite writes and then
  deletes, so the dev server restarted in a loop. `--watch-path=server
  --watch-path=../../packages` watches only what should restart it.
- Dev runs behind nsl (`nsl run --name x-ssr …`). nsl assigns `PORT` and
  serves the app at `x-ssr.localhost:3355`. Vite's default host check
  already allows `*.localhost`, and the HMR websocket follows the page's
  host, so both go through the proxy unchanged.
- Verified in Chromium against the dev server, also through the nsl proxy:
  - `/ada` hydrates with React's development build and reports no mismatches.
  - No GraphQL request at load; the stylesheet applies on first paint.
  - Editing `routes/_index/page.tsx` updates the heading through HMR without
    a full reload.

## 13. Hardening: lint, CSP, persisted queries, error handling

- **[post]** X turned its conventions into lint rules, including an
  "anti-slop" plugin. Here, Biome plus two GritQL plugins
  (`biome-plugins/`): no chained type assertions, and no conditional spreads
  of an empty object. The post's third example, parameters typed as
  `unknown`, is left out on purpose. `unknown` is the safe type for values
  that get narrowed, such as `catch` callbacks.
- **[found]** Biome flagged a conditional hook:
  `primary ? usePreloadedQuery(...) : null` in the route head. It does not
  crash today. A head with no primary query reads only context, and context
  reads take no slot in React's hook list, so both "more hooks" and "fewer
  hooks" go undetected. But going from a profile back to `/` silently drops
  `usePreloadedQuery`'s effect cleanup, and any hook added to that component
  later would crash. The fix renders a different component per case. Browser
  check F1 navigates `/` → `/ada` → back.
- **[found]** Client navigation had no failure path. If the next route's
  chunk failed to load, the click silently did nothing. It now falls back to
  a full page load.
- **[inferred]** Preloads: `PreloadCache` keeps at most 20 entries for 30 s
  and disposes the query refs it drops. A navigation takes ownership of its
  entry, and once the new route commits, the previous route's refs are
  released.
- **[inferred]** CSP: `@x-ssr/server` issues a nonce per request (production)
  and sends `script-src 'self' 'nonce-…'` with no `'unsafe-inline'`. The
  nonce goes to `renderToPipeableStream({ nonce })` for React's `$RC`
  scripts, to the stream injector for `__rr.p()`, and to the document's two
  inline scripts. The browser reads it back from `script.nonce`, because the
  attribute is hidden after parsing. The one inline `style` attribute (the
  icon sprite) became a class.
- **[inferred]** Persisted queries: relay-compiler's local persistence
  (`persistConfig`, SHA-256) writes `src/__generated__/persisted-queries.json`.
  Artifacts carry `id` and `text: null`. The server resolves ids for SSR and
  for `/i/api/graphql`, which rejects query text. relay-compiler requires the
  file to exist before compiling, so `codegen` seeds it.
- **[found]** Switching to persisted queries broke the browser checks' request
  logger, which parsed the operation name out of `query`. Requests now carry
  `operationName` (the standard field; the server ignores it).

- **[found]** `//evil.com.` rendered the home page with 200. The URL cleanup
  guard correctly refused to redirect it, but the renderer then parsed the
  path with `new URL(url, base)`, which reads a leading `//` as
  protocol-relative and yields `/`. `requestPath()` now takes the path
  literally, so the request is not a route of the new app (404; the edge
  would send it to rweb).
- **[inferred]** Scroll restoration: `history.scrollRestoration = 'manual'`,
  and each history entry carries a key. The scroll position is saved under
  the entry being left. On `popstate` the entry has already changed, but
  `scrollY` still belongs to the old page. After the target route commits,
  a layout effect scrolls: to 0 after a push, or to the saved position after
  back/forward. Keys come from `Math.random()`: `crypto.randomUUID()` exists
  only in secure contexts, and it would have broken navigation over plain
  http.
- **[inferred]** Relative timestamps ("3h", "Nov 1"): the server and the
  hydration pass render the absolute time, which is the same everywhere, and
  an effect switches to relative time afterwards, so the clock can never
  cause a hydration mismatch. Crawler documents never hydrate and keep the
  absolute time. While writing this, the anti-slop rule caught
  `...(sameYear ? {} : { year: 'numeric' })` in the new code.

## 14. Supervision, the API tier, compression

- **[post] Watt replacing a stuck worker, verified.**
  `scripts/watt-stall-check.mjs` starts Watt with 4 workers and calls
  `/__debug/stall`, a route registered only with `DEBUG_STALL_ROUTE=1` that
  busy-waits like a stuck render. Measured:
  - before the stall, 8/8 requests succeed;
  - during it, 9–11 of 12 succeed, and the requests routed to the stuck
    worker time out ("one stuck render only affects that worker's requests");
  - about 11 s after the stall starts, Watt logs
    `The worker N of the application "web" is unhealthy. Replacing it ...`
    (checks every 1 s, `maxUnhealthyChecks: 10`);
  - afterwards, 16/16 succeed.
- **[inferred] The API tier is a service of its own.** `apps/api` serves the
  guest token, feature flags and persisted GraphQL, and owns the
  persisted-query check. The web server calls it over HTTP (`API_URL`): SSR
  sends the fresh guest token as `x-guest-token`, while browsers send the
  `gt` cookie. As on x.com, the browser calls `/i/api/*` on the site's
  origin. The edge would route that path to the API; here the web server
  forwards it, marked as a stand-in. `withTimeout()` went away: the client
  uses `AbortSignal.timeout`, which also aborts the request.
- **[inferred] HTML compression without breaking streaming.** A compressor
  buffers until it has enough input, which would hold back the shell. The
  body stream writes one chunk per React flush (the injector only emits at
  flush points), so `@x-ssr/server` flushes br/gzip after every chunk. Brotli
  runs at quality 4, because the default 11 is too slow for on-the-fly use.
  Measured on `/ada`:
  - 32.5 KB became 2.8 KB on the wire (91% smaller);
  - the shell still decodes at about 206 ms and the timeline at about 646 ms,
    as without compression;
  - browser check D1 (shell hydrated before the document finishes) passes
    under br in Chromium.

## 15. SSR core: lifecycle, recovery, cancellation, security tests

- **[found] Disposing a query didn't cancel it.** `PreloadedQuery.dispose()`
  releases the retained data and unsubscribes from the network. Neither of
  our networks returned a cleanup function, so unsubscribing cancelled
  nothing: the browser's fetch ran on, a waiter stayed registered for the
  stream, and the server's upstream call kept going.
  - The browser's fetch function (`relay/replay-network.ts`, unit-tested
    without a DOM) now removes its waiter and aborts the fetch on
    unsubscribe. It also times out after 10 s, and treats a non-2xx response
    as an error instead of handing `{ error }` to Relay as if it were data.
  - The server network aborts its upstream call the same way.
- **[found] Navigation race.** An older navigation that resolved after a
  newer one committed over it and leaked its refs. `createNavigationGate()`
  lets only the latest commit; a superseded one disposes what it owns.
- **[inferred] Store lifecycle (`relay/store.ts`).**
  - Browser: the 10 most recently released queries stay in the release
    buffer, so back navigation renders without a refetch. Data older than
    5 minutes is stale, so `store-or-network` refetches it.
  - Server: one store per request with no buffer. Refs are disposed when the
    render completes, aborts or times out.
  - Tests drive real `relay-runtime` and `loadQuery`, and fail against
    Relay's default store.
- **[inferred] Failure in one section.** `StreamedSection` wraps each
  streamed part (timeline, replies) in its own error boundary with a retry,
  which runs `loadQuery` again with `network-only` and releases the refs the
  retry created. If a section's query fails on the server, React hands the
  boundary to the browser; the browser asks the API, and if that fails too,
  the section, and only the section, shows "Couldn't load … Retry". The
  hydration's `onRecoverableError` logs that hand-off as a warning, not an
  error.
- **[inferred] Stopping a render.**
  - When the client disconnects, the web server aborts: React stops, the
    request's refs are disposed, and upstream calls are cancelled. This is
    counted as `renders.aborted`.
  - `RENDER_TIMEOUT_MS` (10 s) aborts boundaries that are still pending, so
    the browser fetches them itself.
  - Both are covered by tests on the real SSR entry with a conversation that
    never answers: the stream ends, the post is there, and the upstream call
    is cancelled.
- **Security regression tests** (`ssr/render.test.ts`). These render real
  routes through the real `render()` and parse the HTML:
  - every executable script carries the nonce: ours, the stream injector's,
    and React's;
  - no nonce attributes appear when CSP is off;
  - no `on*` attributes and no `javascript:` URLs;
  - JSON data blocks never contain `</script` or `<!--` and still parse;
  - a reply whose text is `</script><b>escaped?</b>` produces no `<b>`
    element;
  - crawler documents carry only escaped JSON-LD, and preview documents
    carry no scripts.
- **Mutation checks.** Each new test was run against a deliberately broken
  implementation and failed: the injector without its nonce, the renderer
  ignoring `renderTimeoutMs`, and the store with Relay's defaults.
- **Test harness for failures.** With `DEBUG_FAILURES=1` (CI only), an
  `x-debug-fail: ConversationQuery` header makes the API answer 503 for that
  operation, on the server's calls and the browser's. Browser checks H1/H2
  use it.

### GraphQL errors (added after §15's first pass)

- **[found]** Relay ignores field errors when a response has data. A failing
  non-null field (`replies`) nulls its parent up to the root (`post: null`),
  and the section rendered as empty, with no sign of failure.
  `relay/response-policy.ts`, applied in both networks, sets the policy:
  - errors with no root data left mean the operation failed and throws, which
    shows the section error with its retry;
  - errors with some root data are kept as partial success and reported;
  - `null` without errors stays "not found".
    On the server, a failed operation is not streamed into the page, so the
    browser asks the API itself. Browser check H3 uses
    `x-debug-fail: ConversationQuery:graphql`, which makes the API return 200
    with exactly that bubbled shape.
- **[found]** Errors React raised before the shell was flushed were never
  logged. `onError` only reported after the shell, to avoid logging shell
  errors twice. But a section whose query fails while the shell is still
  rendering is a boundary error, not a shell error, and its log was dropped.
  Now every error except the shell's own (which is rejected and logged by
  the caller) is reported.

### Crawler byte budget, Watt in CI

- **[post]** Googlebot reads only the first 2 MB of a response.
  - At runtime, crawler responses pass through `withByteBudget()`. An
    oversized document is logged and counted as `crawler.over_budget`.
  - In tests, the mock thread has only 30 replies, so the guard checks the
    cost of one reply. Measured at about 0.8 KB, a 500-reply thread
    projects to roughly 0.4 MB. A regression of 5 KB inline markup per post
    fails the test.
- **[found]** The first version of the guard counted bytes with a `'data'`
  listener. That switches the stream to flowing mode, and Fastify starts
  reading only after its async `onSend` hooks, so every byte emitted before
  then was lost: a consumer arriving 20 ms late got an empty body. Counting
  in a `Transform` fixed it; a test covers the late consumer.
- `scripts/watt-stall-check.mjs` now runs in CI: Watt must replace a worker
  whose event loop is blocked, while the other workers keep serving.

## 16. Load test: what more rendering workers buy

`apps/web/scripts/load-test.mjs` uses autocannon against the production
build under Watt, with 1, 2 and 4 web workers.

- **Setup**
  - The API runs on 4 processes (`apps/api/scripts/cluster.mjs`), so it is
    not the bottleneck; its CPU use is measured to check that.
  - Requests accept br/gzip, like browsers. An independent prober measures
    TTFB; autocannon's latency is the full response, which for a streamed
    page is a very different number.
  - Per-worker ELU and the maximum event-loop delay come from Watt's
    Prometheus metrics. Web and API CPU come from `/proc`.
  - Degradation is invisible in status codes (a section that fails after the
    shell still returns 200), so failed boundaries and upstream timeouts are
    counted from the web server's log.
- **Caveats**
  - One shared 8-vCPU VM (AMD EPYC 7B13). The load generator runs on the same
    machine, with background load averaging 2–5.
  - Single 10 s runs after a 2 s warm-up. The 4-worker numbers moved by up to
    ~30% between runs; the shape held.

**Rendering-bound** (mock API latency 0, 32 connections). Second run:

| workers | scenario                  | req/s | p50 ms | p99 ms | TTFB p50 | ELU (mean) | web cores | API cores |
| ------- | ------------------------- | ----- | ------ | ------ | -------- | ---------- | --------- | --------- |
| 1       | person `/ada`             | 220   | 141    | 199    | 38       | 0.99       | 1.9       | 0.6       |
| 2       | person `/ada`             | 437   | 70     | 114    | 21       | 0.99       | 2.8       | 0.8       |
| 4       | person `/ada`             | 642   | 44     | 104    | 21       | 0.94       | 4.3       | 1.0       |
| 1       | crawler `/ada`            | 249   | 127    | 158    | 56       | 0.99       | 2.0       | 0.4       |
| 4       | crawler `/ada`            | 737   | 43     | 94     | 18       | 0.98       | 4.2       | 1.1       |
| 1       | person `/ada/status/1001` | 218   | 147    | 209    | 33       | 0.99       | 1.6       | 0.5       |
| 4       | person `/ada/status/1001` | 626   | 41     | 110    | 16       | 0.96       | 4.1       | 1.0       |

- One worker saturates (ELU 0.99) at about 220 req/s for this page. Two
  workers double throughput. Four reach 2.4–3×, limited by the shared machine
  rather than by Node.
- A single worker uses about 1.6–2 cores: zlib runs on libuv's thread pool,
  plus GC and Watt's main thread.

**Real upstream latency** (mock latency 60–650 ms, 32 connections):

| workers | req/s | full response p50 | TTFB p50 | ELU (mean) |
| ------- | ----- | ----------------- | -------- | ---------- |
| 1       | 49    | 635 ms            | 153 ms   | 0.32       |
| 2       | 51    | 608 ms            | 147 ms   | 0.21       |
| 4       | 51    | 611 ms            | 147 ms   | 0.13       |

- **[post] confirmed:** the same traffic spread over more workers cuts each
  event loop's share (ELU 0.32 → 0.13).
- Streaming shows here: the first byte comes 4× sooner than the full page
  (TTFB about 150 ms, after the guest token, flags and header query; the
  timeline takes 450 ms more).

**False upstream timeouts: not reproduced cleanly.** The post saw 1–9% of
renders hit a 1 s timeout against a ~25 ms upstream, because event-loop
stalls of 1.9–3.7 s let the timer fire before an already-arrived response was
handled.

- At 256 connections, one worker queues heavily (p50 1.4 s, p99 7 s). The
  longest event-loop delay is still only about 340–410 ms: our renders are
  small, so latency comes from many requests interleaving, not from long
  synchronous stalls. That gives no false timeouts at 1 s.
- With the timeout lowered to 250 ms, one worker still saw none: a stall over
  250 ms is rare, and it must coincide with an in-flight call.
- Four workers saw 66 timeouts (56 failed responses). At that point the 8
  vCPUs were oversubscribed: web 4.8 cores, API 0.9, the load generator,
  and background load. The likely cause is real CPU starvation, not false
  timeouts, but this was not isolated.
- **Lesson:** more workers help only while there are idle cores. Past that,
  they add contention and timeouts. A clean reproduction of the post's claim
  needs a dedicated machine, with the load generator and the API elsewhere.

### Small wins: codegen in dev, client events, scroll across reloads

- **[inferred] Dev codegen.** A `serve`-only Vite plugin reruns
  relay-compiler, debounced, when a file with a `graphql` tag changes.
  Generated files don't retrigger it. Verified: adding a field to a
  fragment updated the artifact and the persisted ids, and the page kept
  rendering. Reverting reverted the artifact; two compiler runs, no loop.
- **[inferred] Client events.** The browser beacons the four kinds of
  degradation only it can see to `/i/api/client-events`. The API counts them
  under fixed keys, validates the payload and limits it to 4 KB. Browser
  checks H1b and H4 assert the counts move.
- **[found]** React reports `onRecoverableError` ("the server errored, the
  client took over") only when the client actually recovers. If the
  browser's own fetch fails too, the section's error boundary catches it and
  no recoverable error is reported. Check H4 therefore fails only the
  document request (Playwright `page.route`); the browser's API call
  succeeds, the replies render, and the recoverable error is counted.
- **[found]** Restoring the scroll position after a reload at
  `DOMContentLoaded` was clamped to 0: the HTML had arrived, but the
  streamed boundaries were not revealed yet, so the page was too short. The
  likely cause is that React reveals Suspense boundaries in batches; this was
  not isolated. The restore now retries on animation frames for up to 2 s
  and stops as soon as the user scrolls, touches or types. Positions persist
  in `sessionStorage` (`pagehide`), keyed by the history entry's key, capped
  at 50 entries.

## 17. Not reconstructed

- The Rust card-image service (record-and-replay plus pixel-diff harnesses).
  The prototype serves a placeholder.
- XDS (Base UI + Tailwind), i18n identity catalogs, the small ICU parser,
  Sentry release-ID stripping, and WebP.
- Module Federation (X Chat, Calls, and Money loaded from their own origins
  with a shared React).
- The real edge: IP verification, the feature switch, and per-country rollout.
- Field metrics (perftown / Core Web Vitals) and Lighthouse CI.
- Relay GC tuning.

## Run

From the repo root:

```bash
pnpm install
pnpm turbo run build typecheck test            # Relay codegen, client + SSR bundles, tsc, Vitest
pnpm dev                                       # dev behind nsl: http://x-ssr.localhost:3355 (Vite middleware + HMR), http://x-ssr-legacy.localhost:3355
PORT=3300 node apps/web/server/main.ts         # or: PORT=3300 pnpm --filter @x-ssr/web start:watt
(cd apps/web && node scripts/probe.ts /ada person|search|preview [--full])
# knobs: REPLIES_LATENCY_MS, UPSTREAM_TIMEOUT_MS

# SEO parity against the legacy reference server
PORT=3301 node apps/legacy-ssr/src/server.ts
pnpm parity                                    # or: node packages/seo-parity/src/seo-parity.ts --old <url> --new <url> [path ...|--paths-file f]
```
