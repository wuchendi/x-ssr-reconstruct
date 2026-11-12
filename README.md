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

- Node.js ≥ 24.2 (runs `.ts` natively; CI uses 26 LTS).
- pnpm 12 workspaces with Turborepo.
- Vite 8 / Rolldown, React 19, Relay 21, Fastify 5, Platformatic Watt 3,
  TypeScript 7, Vitest 5.

## Layout

```
apps/
  web/                @x-ssr/web: the new app
    server/           app routes on top of @x-ssr/server (create() for Watt), main.ts, watt config
    src/              entry-server.tsx (per-audience rendering), ssr/inject.ts (data splicing),
                      relay/, router/, routes/, app/, entries/
    scripts/          probe, browser-check, ngroutes, precompress
    tests/            build-output checks (startup chunk graph)
  legacy-ssr/         @x-ssr/legacy-ssr: stand-in for the old rweb SSR / Jetfuel SSR
packages/
  server/             @x-ssr/server: Fastify assembly, dev (Vite) / production SSR loading, assets, metrics
  mock-api/           @x-ssr/mock-api: mock GraphQL API, guest token, feature flags, schema.graphql
  url-cleanup/        @x-ssr/url-cleanup: trailing-punctuation 301 rule (with open-redirect guard)
  seo-parity/         @x-ssr/seo-parity: SEO parity CLI (bin: seo-parity)
  tsconfig/           @x-ssr/tsconfig: shared TypeScript presets (base, node, react)
scripts/
  clean.sh            removes node_modules, .turbo, dist and Relay artifacts across the workspace
```

Packages ship TypeScript source; Node runs it directly, so there is no
library build step. Every external dependency version lives in the pnpm
catalog (`pnpm-workspace.yaml`), and packages reference it as `catalog:`.
Each package's `tsconfig.json` extends a preset from `@x-ssr/tsconfig`
(`base.json`, `node.json` or `react.json`).

## Quick start

```bash
pnpm install
pnpm build                                # turbo: Relay codegen, then client + SSR bundles, ngroutes.json, precompressed assets
PORT=3300 node apps/web/server/main.ts    # single process
# or
PORT=3300 pnpm --filter @x-ssr/web start:watt   # 4 worker threads with health-based replacement (apps/web/watt.json)
```

Open http://localhost:3300/ada, http://localhost:3300/ada/status/1001 or
http://localhost:3300/nobody (404).

## Development

Dev URLs come from [nsl](https://github.com/dotns/nsl). Install it once,
following its README:

```bash
curl -fsSL https://raw.githubusercontent.com/dotns/nsl/main/install.sh | sh
# or
npm i -g @dotns/nsl
```

Use a global install, not `npx`: the proxy is a background daemon, and nsl's
guide warns that temporary package paths can break it.

```bash
pnpm dev    # turbo: Relay codegen, then both apps behind nsl
```

| App | URL |
|---|---|
| web (`@x-ssr/web`) | http://x-ssr.localhost:3355 |
| legacy reference (`@x-ssr/legacy-ssr`) | http://x-ssr-legacy.localhost:3355 |

nsl picks a free port for each app and passes it in as `PORT`. `nsl get x-ssr`
prints the URL for scripts. For example, to run SEO parity against the dev
servers:

```bash
node packages/seo-parity/src/seo-parity.ts --old "$(nsl get x-ssr-legacy)" --new "$(nsl get x-ssr)"
```

`NODE_ENV=development` switches `@x-ssr/server` from the built
bundles to Vite in middleware mode, behind the same Fastify server:

- **SSR:** modules are loaded per request with `ssrLoadModule`, so edits under
  `src/` show up on the next request. Streaming, the three audiences and data
  replay behave as in production.
- **Browser:** HMR and React Fast Refresh. The HMR websocket shares the HTTP
  port, so it works through the nsl proxy. The stylesheet is still linked
  first, so the first paint is styled.
- **Server code:** `node --watch-path` restarts on changes to `server/` or
  `packages/`. Plain `--watch` would also follow the temporary
  `vite.config` bundle that Vite writes and deletes, and restart in a loop.
- **GraphQL:** run `pnpm --filter @x-ssr/web codegen` after changing a
  `graphql` tag. Relay's watch mode needs watchman, which is not assumed.

## Turbo tasks

| Task | Depends on | Outputs |
|---|---|---|
| `codegen` | — | `src/**/__generated__/**` (Relay artifacts, not committed) |
| `build` | `codegen`, upstream `build` | `dist/**` |
| `typecheck` | `codegen`, upstream `build` | — |
| `test` | `build` (the bundle test reads `dist/`) | — |
| `dev` | `codegen` | — (persistent, not cached) |

```bash
pnpm turbo run build typecheck test       # what CI runs; cached locally in .turbo/
pnpm typecheck                            # or: pnpm build / pnpm test
pnpm turbo run test --filter @x-ssr/url-cleanup
pnpm clean                                # back to a fresh checkout; then pnpm install
```

The unit tests cover:

- the URL cleanup rule, including the open-redirect guard;
- where the stream injector splices data;
- request keys;
- route matching;
- the SEO parity extractor;
- the startup chunk graph;
- the server assembly: manifest-based assets, security headers, metrics, HTML streaming.

The bugs found while building this project each have a regression test.

CI (`.github/workflows/ci.yml`) runs the turbo tasks, then SEO parity and the
browser checks against running servers, on every push and pull request.

## Seeing each audience

The edge's verdict is simulated with the `x-edge-verified-bot` header. The app
never looks at User-Agent. Run these from `apps/web`:

```bash
node scripts/probe.ts /ada person          # chunk-by-chunk arrival times
node scripts/probe.ts /ada search          # verified crawler: one buffered document
node scripts/probe.ts /ada preview --full  # link-preview bot: <head> only
```

Signed-in mode is any request carrying an `auth_token` cookie. For example,
`/home` renders client-side only.

## SEO parity

```bash
PORT=3301 node apps/legacy-ssr/src/server.ts   # stand-in for the old rweb SSR / Jetfuel SSR
pnpm parity                                    # compares :3301 (old) with :3300 (new)
node packages/seo-parity/src/seo-parity.ts --old <url> --new <url> --paths-file paths.txt   # one path per line, # comments
```

The CLI compares:

- status code and redirect target;
- title, description, canonical URL;
- robots tags;
- Open Graph and X card tags;
- number of language alternates;
- JSON-LD types.

It exits with 1 on any difference.

## Browser checks

`apps/web/scripts/browser-check.mjs` runs 16 checks in real Chromium:

- hydration without errors;
- no GraphQL request at load;
- stylesheet-first ordering;
- intent preloading;
- client-side navigation;
- the shell hydrating before the document finishes under Slow 4G;
- signed-in Home.

It needs Playwright with a matching browser:
`pnpm --filter @x-ssr/web exec playwright install chromium`, or the
`mcr.microsoft.com/playwright:v1.65.0-noble` image. Start the server with a
slow conversation upstream so the streaming check is meaningful:

```bash
REPLIES_LATENCY_MS=5000 UPSTREAM_TIMEOUT_MS=10000 PORT=3300 node apps/web/server/main.ts
BASE=http://127.0.0.1:3300 pnpm e2e:browser
```

## Knobs

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` (`3301` for legacy) | Listen port |
| `REPLIES_LATENCY_MS` | `650` | Mock latency of the conversation (replies) query |
| `UPSTREAM_TIMEOUT_MS` | `1000` | Timeout for guest token, flags and GraphQL upstream calls |
| `LOG_LEVEL` | `info` | Fastify log level |

## Not reconstructed

- The Rust card-image service.
- The XDS component library.
- Module Federation (X Chat and similar).
- The real edge: IP verification, feature switch, per-country rollout.
- Field metrics and Lighthouse CI.

See ARCHITECTURE.md §13.

## License

[Apache-2.0](./LICENSE)
