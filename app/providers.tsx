"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { AuthMe } from "@/lib/auth/me";

export default function Providers({
  children,
  initialAuth,
}: {
  children: React.ReactNode;
  initialAuth: AuthMe;
}) {
  // One QueryClient per browser session. Created in state so it isn't recreated
  // on re-render, and never shared across requests (each client gets its own).
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          // Internal tool: keep behavior predictable and close to the old
          // fetch-on-mount model. Data is considered fresh for 30s (so tab
          // switches don't refetch constantly) and we don't auto-refetch on
          // window focus. Mutations refresh explicitly via invalidateQueries.
          staleTime: 30_000,
          refetchOnWindowFocus: false,
          retry: 1,
        },
      },
    });

    // Seed the session the root layout already resolved. This initializer runs
    // on the server render AND again during hydration, so `useAuthMeQuery` has
    // the same answer in both passes — the permission-gated nav renders
    // identically on the server and on the client's first render instead of
    // popping in whenever /api/auth/me happens to land. Sign-in and sign-out
    // both hard-navigate, so this seed can never outlive its session.
    client.setQueryData(queryKeys.auth.me(), initialAuth);
    return client;
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
