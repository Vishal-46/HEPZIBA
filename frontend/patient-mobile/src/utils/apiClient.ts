/**
 * Lightweight React Native API client built on `fetch`.
 *
 * Intentionally dependency-free (no axios) and RN-safe:
 * no `localStorage`, no `import.meta`, no `window`.
 *
 * Auth token is injected by the caller (see `tokenStore.ts` + `App.tsx`),
 * so this module stays testable and has no import cycle.
 */
import { API_BASE_URL } from '../config/api';

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

type TokenProvider = () => string | null | Promise<string | null>;

export type ApiClientOptions = {
  /** Return the current bearer token (sync or async). */
  getToken?: TokenProvider;
  /** Called once when the server answers 401. Use it to log out. */
  onUnauthorized?: () => void;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
  /**
   * Refresh the access token (single-flight). Return the new Bearer token,
   * or null when refresh is unavailable/failed. The failed request is then
   * retried exactly once with the new token before surfacing a 401.
   */
  refreshAccess?: () => Promise<string | null>;
};

export type RequestOptions = Omit<RequestInit, 'body'> & {
  /** JSON-serialisable body (serialised automatically). */
  json?: unknown;
  /** Raw body (used only when `json` is undefined). */
  body?: BodyInit | null;
  /** Override the injected bearer token for a single call. */
  token?: string | null;
  /** Per-call timeout override. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function friendlyNetworkMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Request timed out. Check your connection and try again.';
  }
  if (error instanceof TypeError) {
    // fetch throws TypeError on DNS / refused / offline.
    return 'Cannot reach the server. Check your connection or API URL.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

async function resolveToken(
  opts: ApiClientOptions,
  override?: string | null,
): Promise<string | null> {
  if (override !== undefined) return override;
  const provider = opts.getToken;
  if (!provider) return null;
  try {
    return await provider();
  } catch {
    return null;
  }
}

export function createApiClient(clientOptions: ApiClientOptions = {}) {
  const defaultTimeout = clientOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Single-flight refresh: concurrent 401s share one /auth/refresh call.
  let inflightRefresh: Promise<string | null> | null = null;
  const runRefresh = (): Promise<string | null> => {
    if (!clientOptions.refreshAccess) return Promise.resolve(null);
    if (!inflightRefresh) {
      inflightRefresh = Promise.resolve()
        .then(() => clientOptions.refreshAccess!())
        .then(
          (token) => {
            inflightRefresh = null;
            return token;
          },
          () => {
            inflightRefresh = null;
            return null;
          },
        );
    }
    return inflightRefresh;
  };

  async function request<T = any>(path: string, options: RequestOptions = {}, retried = false): Promise<T> {
    const { json, token: tokenOverride, timeoutMs, headers, ...rest } = options;
    const token = await resolveToken(clientOptions, tokenOverride);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeout);

    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        ...rest,
        signal: controller.signal,
        headers: {
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers ?? {}),
        },
        body: json !== undefined ? JSON.stringify(json) : rest.body ?? undefined,
      });

      if (response.status === 401) {
        // Transparent rotation: one refresh attempt, then exactly one retry.
        if (!retried && tokenOverride === undefined) {
          const fresh = await runRefresh();
          if (fresh) return request<T>(path, { ...options, token: fresh }, true);
        }
        clientOptions.onUnauthorized?.();
        const payload = await safeJson(response);
        const message =
          (payload as any)?.error ?? 'Session expired. Please sign in again.';
        throw new ApiError(message, 401, payload);
      }

      const payload = await safeJson(response);
      if (!response.ok) {
        const message =
          (payload as any)?.error ?? `Request failed (${response.status}).`;
        throw new ApiError(message, response.status, payload);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(friendlyNetworkMessage(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    request,
    get: <T = any>(path: string, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'GET' }),
    post: <T = any>(path: string, json?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'POST', json }),
    put: <T = any>(path: string, json?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'PUT', json }),
    del: <T = any>(path: string, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'DELETE' }),
  };
}

export type RNApiClient = ReturnType<typeof createApiClient>;

/** Shared singleton for screens that don't need their own 401 handler. */
let sharedTokenProvider: TokenProvider | null = null;
let sharedUnauthorizedHandler: (() => void) | null = null;
let sharedRefreshAccess: (() => Promise<string | null>) | null = null;

export function configureApiClient(options: {
  getToken?: TokenProvider;
  onUnauthorized?: () => void;
  refreshAccess?: () => Promise<string | null>;
}): void {
  if (options.getToken !== undefined) sharedTokenProvider = options.getToken;
  if (options.onUnauthorized !== undefined)
    sharedUnauthorizedHandler = options.onUnauthorized;
  if (options.refreshAccess !== undefined) sharedRefreshAccess = options.refreshAccess;
}

const sharedClient = createApiClient({
  getToken: () => sharedTokenProvider?.() ?? null,
  onUnauthorized: () => sharedUnauthorizedHandler?.(),
  refreshAccess: () => sharedRefreshAccess?.() ?? Promise.resolve(null),
});

/** Convenience wrappers that honour `configureApiClient`. */
export const apiGet = <T = any>(path: string, options?: RequestOptions) =>
  sharedClient.get<T>(path, options);
export const apiPost = <T = any>(
  path: string,
  json?: unknown,
  options?: RequestOptions,
) => sharedClient.post<T>(path, json, options);
export const apiPut = <T = any>(
  path: string,
  json?: unknown,
  options?: RequestOptions,
) => sharedClient.put<T>(path, json, options);
export const apiRequest = <T = any>(path: string, options?: RequestOptions) =>
  sharedClient.request<T>(path, options);

export default sharedClient;
