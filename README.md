# x-ssr-reconstruct

A runnable reconstruction of the server-rendering architecture described in
X Engineering's post
[Rebuilding the global town square from scratch](https://blog.x.com/en/engineering/rebuilding-the-global-town-square-from-scratch)
(Nov 2026): Fastify + React streaming SSR + Relay, served by Platformatic Watt.

X's code is not public. This project rebuilds the design from the post using
mock data, then checks the behaviour by running it. It is not affiliated with
X. For the breakdown, see [ARCHITECTURE.md](./ARCHITECTURE.md). Every claim
there is tagged as stated in the post, inferred, or found while building.

## What it demonstrates

- **One server, three audiences.**
  - People get streamed HTML (shell first, then each Suspense boundary).
  - Verified crawlers get one finished document with no JS.
  - Link-preview bots get `<head>` only, and the body queries are never sent.
- **GraphQL responses streamed once, as JSON text.** The browser replays them
  into an empty Relay store, so no GraphQL request is made at page load.
- **Route loaders.** Every route starts its queries before rendering. The
  primary query decides the status code (real 404s) and `<head>`.
- **Stylesheet first, async entry.** JS starts only after the CSS has loaded,
  and the shell hydrates long before the streamed document finishes.
- **Intent preloading.** Links preload on hover or focus. Posts preload after
  a 100 ms pointer dwell, but not when they only scroll under a still pointer.
- **Three startup chunks** with Rolldown: dependencies, app code, and the lazy
  chunk name map.
- **SEO parity script.** It compares two servers field by field, as a verified
  Googlebot would see them.

## Stack

Node.js ≥ 24.2 (runs `.ts` natively), pnpm, Vite 8 / Rolldown, React 19,
Relay 21, Fastify 5, Platformatic Watt 3, TypeScript 7.

## Quick start

```bash
pnpm install
pnpm build                     # relay-compiler, client + SSR bundles, ngroutes.json, precompressed assets
PORT=3300 node server/main.ts  # single process
# or
PORT=3300 npx wattpm start     # 4 worker threads with health-based replacement (watt.json)
```

Open http://localhost:3300/ada, http://localhost:3300/ada/status/1001 or
http://localhost:3300/nobody (404).

Relay artifacts (`__generated__/`) are not committed. Run `pnpm relay` (or
`pnpm build`) before type-checking:

```bash
pnpm relay && npx tsc -p .
```

## Seeing each audience

The edge's verdict is simulated with the `x-edge-verified-bot` header. The app
never looks at User-Agent.

```bash
node scripts/probe.ts /ada person          # chunk-by-chunk arrival times
node scripts/probe.ts /ada search          # verified crawler: one buffered document
node scripts/probe.ts /ada preview --full  # link-preview bot: <head> only
```

Signed-in mode is any request carrying an `auth_token` cookie. For example,
`/home` renders client-side only.

## SEO parity

```bash
PORT=3301 node server/legacy-ssr.ts   # stand-in for the old rweb SSR / Jetfuel SSR
node scripts/seo-parity.ts --old http://127.0.0.1:3301 --new http://127.0.0.1:3300
node scripts/seo-parity.ts --old ... --new ... --paths-file paths.txt   # one path per line, # comments
```

The script compares:

- status code and redirect target;
- title, description, canonical URL;
- robots tags;
- Open Graph and X card tags;
- number of language alternates;
- JSON-LD types.

It exits with 1 on any difference.

## Browser checks

`scripts/browser-check.mjs` runs 16 checks in real Chromium:

- hydration without errors;
- no GraphQL request at load;
- stylesheet-first ordering;
- intent preloading;
- client-side navigation;
- the shell hydrating before the document finishes under Slow 4G;
- signed-in Home.

It needs Playwright with a matching browser, for example the
`mcr.microsoft.com/playwright:v1.64.1-noble` image. Point `BASE` at the
server, and start the server with a slow conversation upstream so the
streaming check is meaningful:

```bash
REPLIES_LATENCY_MS=5000 UPSTREAM_TIMEOUT_MS=10000 PORT=3300 node server/main.ts
BASE=http://<host>:3300 node scripts/browser-check.mjs
```

## Knobs

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` (`3301` for legacy) | Listen port |
| `REPLIES_LATENCY_MS` | `650` | Mock latency of the conversation (replies) query |
| `UPSTREAM_TIMEOUT_MS` | `1000` | Timeout for guest token, flags and GraphQL upstream calls |
| `LOG_LEVEL` | `info` | Fastify log level |

## Layout

```
server/
  app.ts            Fastify app (create() for Watt): edge contract, upstreams, assets, render route
  main.ts           standalone entry with graceful shutdown
  backend.ts        mock GraphQL API, guest token and feature flags with simulated latency
  url-cleanup.ts    trailing-punctuation 301 rule ported from the old servers
  legacy-ssr.ts     legacy reference server for SEO parity
src/
  entry-server.tsx  per-audience rendering
  ssr/inject.ts     splices GraphQL responses into the React stream at flush boundaries
  relay/            server environment (records responses), client environment (replays them)
  router/           file-based routes, loaders, lazy page chunk map
  routes/           route tree: loader.ts (queries + head) and page.tsx per route
  app/              App, Document (<head> per audience), stylesheet-first loader
  entries/          logged-out and signed-in client entry points
scripts/            probe, seo-parity, browser-check, ngroutes, precompress
```

## Not reconstructed

- The Rust card-image service.
- The XDS component library.
- Module Federation (X Chat and similar).
- The real edge: IP verification, feature switch, per-country rollout.
- Field metrics and Lighthouse CI.

See ARCHITECTURE.md §12.

## License

[Apache-2.0](./LICENSE)
