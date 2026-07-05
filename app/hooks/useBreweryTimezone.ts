"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_BREWERY_TZ, timezoneLabel, type TimezoneOption } from "@/lib/settings/breweryTimezone";

export interface BreweryTimezoneResponse {
  timezone: string;
  label: string;
  options: readonly TimezoneOption[];
}

// Active brewery timezone for client components. While the value loads it
// resolves to the compile-time default, so date math never renders against
// `undefined`; it re-renders with the configured zone once the query settles.
export function useBreweryTimezone() {
  const query = useQuery({
    queryKey: queryKeys.settings.breweryTimezone(),
    queryFn: () => fetchJson<BreweryTimezoneResponse>("/api/settings/timezone"),
    staleTime: 5 * 60 * 1000,
  });

  return {
    timezone: query.data?.timezone ?? DEFAULT_BREWERY_TZ,
    label: query.data?.label ?? timezoneLabel(DEFAULT_BREWERY_TZ),
    options: query.data?.options ?? [],
    isLoading: query.isLoading,
  };
}
