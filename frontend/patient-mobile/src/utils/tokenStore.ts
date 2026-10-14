/**
 * Persistent session storage for React Native.
 *
 * Uses `expo-secure-store` on native devices, with an in-memory fallback so
 * the app still works on web / simulators where SecureStore is unavailable.
 * No `localStorage` / `window` access — safe for all RN targets.
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { Session, User } from './sessionTypes';

const TOKEN_KEY = 'hepziba.auth.token';
const USER_KEY = 'hepziba.auth.user';
const REFRESH_KEY = 'hepziba.auth.refresh';

const memoryFallback = new Map<string, string>();

function secureStoreAvailable(): boolean {
  // SecureStore is unavailable on web; guard everything behind try/catch too.
  return Platform.OS !== 'web';
}

async function storeSet(key: string, value: string): Promise<void> {
  if (secureStoreAvailable()) {
    try {
      await SecureStore.setItemAsync(key, value);
      return;
    } catch {
      // Fall through to memory (e.g. no hardware keystore in simulator).
    }
  }
  memoryFallback.set(key, value);
}

async function storeGet(key: string): Promise<string | null> {
  if (secureStoreAvailable()) {
    try {
      const value = await SecureStore.getItemAsync(key);
      if (value !== null) return value;
    } catch {
      // Fall through to memory.
    }
  }
  return memoryFallback.get(key) ?? null;
}

async function storeDelete(key: string): Promise<void> {
  memoryFallback.delete(key);
  if (secureStoreAvailable()) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Best effort — memory copy is already cleared.
    }
  }
}

export async function saveSession(session: Session): Promise<void> {
  const ops: Promise<void>[] = [
    storeSet(TOKEN_KEY, session.token),
    storeSet(USER_KEY, JSON.stringify(session.user)),
  ];
  if (session.refreshToken) ops.push(storeSet(REFRESH_KEY, session.refreshToken));
  await Promise.all(ops);
  // Keep the in-memory copy warm so reads are synchronous-fast after login.
  memoryFallback.set(TOKEN_KEY, session.token);
  memoryFallback.set(USER_KEY, JSON.stringify(session.user));
  if (session.refreshToken) memoryFallback.set(REFRESH_KEY, session.refreshToken);
}

export async function loadSession(): Promise<Session | null> {
  try {
    const [token, rawUser, refreshToken] = await Promise.all([
      storeGet(TOKEN_KEY),
      storeGet(USER_KEY),
      storeGet(REFRESH_KEY),
    ]);
    if (!token) return null;
    let user: User | null = null;
    if (rawUser) {
      try {
        user = JSON.parse(rawUser) as User;
      } catch {
        user = null;
      }
    }
    // Token without a cached user is still a valid session — the App will
    // re-fetch /patients/me to hydrate. Keep a minimal placeholder.
    return {
      token,
      ...(refreshToken ? { refreshToken } : {}),
      user: user ?? { id: 0, name: '', email: '', role: 'patient' as const },
    };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await Promise.all([storeDelete(TOKEN_KEY), storeDelete(USER_KEY), storeDelete(REFRESH_KEY)]);
}
