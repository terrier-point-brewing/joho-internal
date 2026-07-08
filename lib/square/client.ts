import { env } from "@/lib/env";

const BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-04-16";

/**
 * Error thrown by every Square request wrapper on a non-2xx response. Carries
 * the HTTP `status` and the first Square error `code` so callers can branch on
 * the failure kind (e.g. a deleted invoice → 404 / `NOT_FOUND`) instead of
 * string-matching the human-readable detail.
 */
export class SquareApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, detail: string) {
    super(detail);
    this.name = "SquareApiError";
    this.status = status;
    this.code = code;
  }

  /** True when Square reported the resource does not exist. */
  get isNotFound(): boolean {
    return this.status === 404 || this.code === "NOT_FOUND";
  }
}

/**
 * Type-safe "resource no longer exists in Square" check for a caught `unknown`.
 * A deleted invoice/order/etc. surfaces as a 404 with a `NOT_FOUND` error code.
 */
export function isSquareNotFound(err: unknown): boolean {
  return err instanceof SquareApiError && err.isNotFound;
}

function makeHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.squareAccessToken()}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** Builds a typed error from a failed Square response body. */
function squareApiError(status: number, data: unknown, fallback: string): SquareApiError {
  const err = (data as { errors?: { code?: string; detail?: string }[] }).errors?.[0];
  return new SquareApiError(status, err?.code ?? null, err?.detail ?? fallback);
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
  if (!res.ok) throw squareApiError(res.status, data, `Square GET ${path} failed`);
  return data as T;
}

export async function squarePost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw squareApiError(res.status, data, `Square POST ${path} failed`);
  return data as T;
}

export async function squareDelete(path: string, params?: Record<string, string>): Promise<void> {
  const url = new URL(`${BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method: "DELETE", headers: makeHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw squareApiError(res.status, data, `Square DELETE ${path} failed`);
  }
}

export async function squarePut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: makeHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw squareApiError(res.status, data, `Square PUT ${path} failed`);
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
