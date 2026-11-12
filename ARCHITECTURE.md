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

`server/app.ts` → `create()`

- **[post]** Fastify handles every request. The app is assembled from
  configuration: security headers, cookies, metrics, streaming rendering, and
  graceful shutdown.
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
  timeouts. `withTimeout()` carries the note.
- **[found]** When an upstream times out *after* the shell has been sent,
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

| Audience | React callback | What is sent |
|---|---|---|
| person | `onShellReady` | Shell first, then each Suspense boundary plus its GraphQL responses as they resolve |
| verified crawler | `onAllReady` | One finished document: JSON-LD, no client bundle, no router state, no data scripts, no skeletons or sign-in buttons |
| link-preview bot | `onAllReady` | `<head>` only. `loadRoute(..., { headOnly: true })` never sends the timeline/conversation queries |

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
  **once, as JSON text**. The normalized Relay store is *not* serialized: those
  records were 4–5× the size of the responses.
- One Relay `Environment` per request (`isServer: true`). Its network
  `fetchFn` hands the raw response text to the injector.

### Injector: where data can be spliced into the stream

- **[found]** React's Node writer emits fixed-size views, so a `write()` can
  end in the middle of a tag. The only safe splice points are where React calls
  `destination.flush()`. It calls that at the end of every flush cycle:
  `completeWriting(); flushBuffered()` → `destination.flush()`. That covers the
  shell, each completed boundary, and the final `</body></html>`.
- `ResponseInjector` is a `Transform` that buffers React's bytes, implements
  `flush()`, and emits at those points:
  - **First flush (the shell):** shell first, then data. Nothing may precede
    `<!DOCTYPE html>`.
  - **Later flushes:** data first, then the boundary, so the response is in the
    DOM before React reveals and hydrates the boundary that needs it.
- **[found]** When the shell *is* the whole document (no pending boundaries,
  e.g. a 404 profile), the first flush already ends with `</body></html>`.
  Appending data there put scripts after `</html>`, so data is spliced in
  before `</body></html>` instead.
- Escaping: `<` becomes `<` (still valid JSON), and U+2028/2029 are
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
  (from the Vite manifest; `resolveAssets()`) and the entry script.
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
  2. **Chunk cycle.** The route table imported the loaders (app code) *and*
     named the lazy pages. That put a static `startup-app ⇄ startup-names`
     cycle in the bundle, which crashed at runtime
     (`Cannot read properties of undefined (reading 'default')`). The module
     that names lazy chunks must contain *only* dynamic imports
     (`router/page-chunks.ts`).
  3. **Entry modules must stay out of shared groups.** Captured into
     `startup-app`, both entries' top-level code ran in every entry. Both
     `boot(false)` and `boot(true)` hydrated the same document, which produced
     React #418, duplicate API calls, and the wrong route on `/home`.

## 10. Verification

These were run against the production build.

### `scripts/probe.ts`: chunk arrival timing

| Request | Result |
|---|---|
| person `/ada` | 193 ms: shell (3.8 KB) plus the header query response. 641 ms: timeline response, then the boundary (27.5 KB) |
| crawler `/ada` | 644 ms: one 22 KB document, 1 script (JSON-LD), 20 posts inline |
| crawler `/nobody` | HTTP 404, complete document |
| preview `/ada/status/1001` | 1.3 KB, `<head>` only, ~200 ms (the 650 ms conversation query is skipped) |

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

`server/app.ts` → `developmentRenderer()`

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

## 13. Not reconstructed

- The Rust card-image service (record-and-replay plus pixel-diff harnesses).
  The prototype serves a placeholder.
- XDS (Base UI + Tailwind), i18n identity catalogs, the small ICU parser,
  Sentry release-ID stripping, and WebP.
- Module Federation (X Chat, Calls, and Money loaded from their own origins
  with a shared React).
- The real edge: IP verification, the feature switch, and per-country rollout.
- Field metrics (perftown / Core Web Vitals) and Lighthouse CI.
- Disposal of preloaded query refs, Relay GC tuning, and error boundaries.

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
