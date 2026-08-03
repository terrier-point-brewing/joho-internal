// Server-side half of React Query: build a throwaway client, prefetch into it,
// and hand the dehydrated cache to a <HydrationBoundary> so the browser starts
// with the data already in hand.
//
// Why this exists: every client page in this app fetches on mount, which cannot
// happen until the route's JS has downloaded, parsed and hydrated. On the
// Financials page that pushed the first byte of statement data past 1.8s before
// the request even left the browser. Prefetching on the server moves that work
// into the render that is already happening, and Next streams the result in
// behind the route's loading.tsx skeleton -- so the page still paints
// immediately, but the data arrives without a second round trip.
//
// One client PER REQUEST, never a module-level singleton: a shared client would
// leak one user's statements into another user's render.

import { QueryClient } from "@tanstack/react-query";

/**
 * A QueryClient scoped to a single server render.
 *
 * `staleTime` mirrors app/providers.tsx. It matters here because a query
 * dehydrated as already-stale is refetched by the browser the moment it
 * hydrates -- which would leave the round trip this exists to remove, plus the
 * bytes of the prefetch on top.
 */
export function createServerQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
      },
    },
  });
}
