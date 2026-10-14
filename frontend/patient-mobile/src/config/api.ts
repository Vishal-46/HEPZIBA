/**
 * Central API configuration for patient-mobile (Expo + React Native).
 *
 * Uses EXPO_PUBLIC_API_URL with a dev fallback so physical devices on the
 * same LAN keep working without extra setup. Never hardcode per-developer
 * IPs in screen code — import from here instead.
 */

const DEV_FALLBACK_URL = 'http://192.168.0.240:3000';

function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  return trimmed || DEV_FALLBACK_URL;
}

// `process.env.EXPO_PUBLIC_*` is inlined by Expo at build time (works on
// native + web). No `import.meta` / `window` / `localStorage` here.
export const API_BASE_URL = normalizeBaseUrl(process.env.EXPO_PUBLIC_API_URL);

export function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${suffix}`;
}

export const GOOGLE_AUTH_CONFIG = {
  androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '',
  expoClientId: process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID ?? '',
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '',
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
} as const;

/**
 * @deprecated Backend-mediated OAuth needs no frontend client IDs.
 * Google only sees the backend redirect URI, so `exp://` is never sent to
 * Google. Kept as a stub so old imports don't break.
 */
export function isGoogleConfigured(): boolean {
  return true;
}

/**
 * Optional Cloudinary upload endpoint / preset.
 * Leave unset to run in local-only mode (picked image URI is stored as
 * `photo_url` without remote upload).
 */
export const CLOUDINARY_UPLOAD_URL = (process.env.EXPO_PUBLIC_CLOUDINARY_URL ?? '').trim();
export const CLOUDINARY_UPLOAD_PRESET = (
  process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET ?? ''
).trim();
