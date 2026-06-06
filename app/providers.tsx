"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export default function Providers({ children }: { children: React.ReactNode }) {
  // One QueryClient per browser session. Created in state so it isn't recreated
  // on re-render, and never shared across requests (each client gets its own).
  const [queryClient] = useState(
    () =>
      new QueryClient({
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
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
