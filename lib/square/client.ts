import { env } from "@/lib/env";

const BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-04-16";

function makeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.squareAccessToken()}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** Validated Square location ID from env, shared across all Square modules. */
export function squareLocationId(): string {
  return env.squareLocationId();
}

export async function squareGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: makeHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.detail ?? `Square GET ${path} failed`);
  return data as T;
}

export async function squarePost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.detail ?? `Square POST ${path} failed`);
  return data as T;
}

export async function squarePut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: makeHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.detail ?? `Square PUT ${path} failed`);
  return data as T;
}

// Fetches all pages of a GET endpoint that uses cursor-based pagination.
// `key` is the array field name in the response (e.g. "objects").
export async function squareGetAll<T>(
  path: string,
  key: string,
  params?: Record<string, string>
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined;
  do {
    const p = cursor ? { ...params, cursor } : params;
    const data = await squareGet<Record<string, unknown>>(path, p);
    results.push(...((data[key] as T[]) ?? []));
    cursor = data.cursor as string | undefined;
  } while (cursor);
  return results;
}

// Fetches all pages of a POST endpoint that uses cursor-based pagination.
// `key` is the array field name in the response.
export async function squarePostAll<T>(
  path: string,
  key: string,
  body: Record<string, unknown>
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | undefined;
  do {
    const data = await squarePost<Record<string, unknown>>(path, cursor ? { ...body, cursor } : body);
    results.push(...((data[key] as T[]) ?? []));
    cursor = data.cursor as string | undefined;
  } while (cursor);
  return results;
}
