export type Fetch = typeof fetch;

/** An error answer from Google's or Microsoft's API. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A reconnect is needed: the account's sign-in expired or was revoked. */
export class ReauthError extends Error {}

/** Pulls the human-readable part out of an API error body (Google and Graph shapes, and OAuth errors). */
function errorText(body: unknown, status: number) {
  const value = body as { error?: { message?: string } | string; error_description?: string } | null;
  const text = typeof value?.error === "object" ? value.error.message : value?.error_description || value?.error;
  return (text || `The service answered ${status}.`).replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Calls a JSON API with a bearer token. Waits out one rate-limit answer (429/503 with
 * Retry-After) before giving up.
 */
export async function callApi<T>(
  fetchImpl: Fetch,
  token: () => Promise<string>,
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${await token()}`,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    });
    if ((response.status === 429 || response.status === 503) && attempt === 0) {
      const wait = Math.min(10, Number(response.headers.get("retry-after")) || 2);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    if (response.status === 202 || response.status === 204) return undefined as T;
    const text = await response.text();
    const body = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!response.ok) throw new ApiError(response.status, errorText(body, response.status));
    return body as T;
  }
}

/** Posts an OAuth form (token and device-code endpoints) and returns the JSON answer, error or not. */
export async function postForm(fetchImpl: Fetch, url: string, form: Record<string, string>) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, body, error: errorText(body, response.status) };
}
