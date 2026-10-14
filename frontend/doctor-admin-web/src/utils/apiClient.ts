import axios, { AxiosError } from 'axios';

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() || 'http://localhost:3000';

export const TOKEN_KEY = 'hepziba.token';
export const USER_KEY = 'hepziba.user';
export const REFRESH_KEY = 'hepziba.refresh';

/** Read the stored token. Supports the legacy `token` key for backward compat. */
export function getStoredToken(): string | null {
  try {
    return (
      localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem('token')
    );
  } catch {
    return null;
  }
}

function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function clearStoredAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(REFRESH_KEY);
    // Legacy key cleanup.
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  } catch {
    // Storage may be unavailable (private mode); ignore.
  }
}

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Single-flight silent refresh: concurrent 401s share one /auth/refresh call.
let inflightRefresh: Promise<string | null> | null = null;
function runRefresh(): Promise<string | null> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return Promise.resolve(null);
  if (!inflightRefresh) {
    inflightRefresh = axios
      .post(`${API_BASE_URL}/auth/refresh`, { refreshToken }, { timeout: 15000 })
      .then((res) => {
        const data = res.data as { token?: string; refreshToken?: string; user?: unknown };
        if (!data?.token) return null;
        try {
          localStorage.setItem(TOKEN_KEY, data.token);
          localStorage.setItem('token', data.token);
          if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
          if (data.user) localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        } catch {
          // Storage unavailable; the retry below still uses the new token.
        }
        return data.token;
      })
      .catch(() => null)
      .then((token) => {
        inflightRefresh = null;
        return token;
      });
  }
  return inflightRefresh;
}

function redirectToLogin(): void {
  // Avoid redirect loops when already on /login or in a test env.
  if (
    typeof window !== 'undefined' &&
    !window.location.pathname.startsWith('/login')
  ) {
    window.location.href = '/login';
  }
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (typeof error.config & { _retry?: boolean }) | undefined;
    if (error.response?.status === 401 && original && !original._retry) {
      original._retry = true;
      const fresh = await runRefresh();
      if (fresh) {
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization = `Bearer ${fresh}`;
        return apiClient(original);
      }
    }
    if (error.response?.status === 401) {
      clearStoredAuth();
      redirectToLogin();
    }
    return Promise.reject(error);
  },
);

/** Extract a human-readable message from an axios/fetch error payload. */
export function apiErrorMessage(error: unknown, fallback = 'Request failed'): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string; message?: string } | undefined;
    return data?.error || data?.message || error.message || fallback;
  }
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

export default apiClient;
