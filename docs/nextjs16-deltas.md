# Next.js 16 Deltas (vs. model training data)

Distilled from `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`. Read this **instead of** browsing `node_modules/next/dist/docs/` — fall back to the full docs only if a question isn't covered here.

## Breaking changes that affect this repo

- **Async request APIs — sync access fully removed.** `cookies()`, `headers()`, `draftMode()`, `params` (layout/page/route/default), and `searchParams` (page) are ALL async — always `await` them. Route handler context: `const { id } = await context.params`. Typegen helpers exist: `PageProps<'/path/[slug]'>`, `LayoutProps`, `RouteContext` (via `npx next typegen`).
- **`middleware` → `proxy`.** This repo uses `proxy.ts` (repo root) with `export function proxy(request)`. Never create `middleware.ts`. Proxy runtime is `nodejs` only (no edge). Config flags renamed too (e.g. `skipProxyUrlNormalize`).
- **`next lint` removed.** `npm run lint` runs the ESLint CLI directly (flat config, `eslint.config.mjs`). `next build` does NOT lint — run lint separately.
- **Turbopack is the default** for `dev` and `build`; no `--turbopack` flag needed. Turbopack config is top-level `turbopack` in `next.config.ts`, not `experimental.turbopack`.
- **`next dev` outputs to `.next/dev`** (separate from build output); dev and build can run concurrently; a lockfile prevents duplicate dev servers. Stale `.next/dev` artifacts can cause phantom tsc/build errors — clear them if results look wrong.
- **Parallel route slots require explicit `default.js`** — builds fail without them.
- **Caching:** `revalidateTag(tag)` now requires a second `cacheLife` profile arg, e.g. `revalidateTag('posts', 'max')`. New: `updateTag()` (Server Actions, read-your-writes) and `refresh()` (refresh client router from a Server Action). `cacheLife`/`cacheTag` are stable (no `unstable_` prefix). PPR flag removed — opt in via `cacheComponents: true`.
- **`next/image`:** `images.domains` deprecated (use `remotePatterns`); local images with query strings need `localPatterns.search`; default quality locked to `[75]`; `minimumCacheTTL` default now 4h.
- **Removed:** AMP, `serverRuntimeConfig`/`publicRuntimeConfig` (use env vars; `NEXT_PUBLIC_` for client), `experimental.dynamicIO` (→ `cacheComponents`), `unstable_rootParams`, `next/legacy/image`.
- **React 19.2 canary** in App Router; React Compiler support stable via `reactCompiler: true` (this repo has `babel-plugin-react-compiler` installed).

## Repo baselines (already conform — don't "fix")

- `proxy.ts` at repo root is correct and intentional.
- Route handlers declare `export const dynamic = "force-dynamic"` where needed.
- `next.config.ts` is minimal; don't add webpack config (Turbopack build would fail).
