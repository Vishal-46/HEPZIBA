import { Platform } from 'react-native';
import { API_BASE_URL } from '../config/api';

// NOTE: expo-device / expo-notifications are imported lazily inside the
// functions below so the web bundle (which has no ExpoDevice native module)
// never evaluates them at load time.

// Foreground presentation: show a banner even while the app is open.
let handlerSet = false;
async function ensureHandler() {
  if (handlerSet || Platform.OS === 'web') return;
  try {
    const { setNotificationHandler } = await import('expo-notifications');
    setNotificationHandler({
      handleNotification: async () => ({
        shouldPresentAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    handlerSet = true;
  } catch {
    // Notifications unavailable — in-app polling still applies.
  }
}

export async function registerPushToken(authToken: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return null;
    const Device = await import('expo-device');
    if (!Device.isDevice) return null;
    const Notifications = await import('expo-notifications');
    const { status: existing } = await Notifications.getPermissionsAsync();
    const finalStatus = existing === 'granted'
      ? existing
      : (await Notifications.requestPermissionsAsync()).status;
    if (finalStatus !== 'granted') return null;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Visit updates',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const Constants = (await import('expo-constants')).default;
    const projectId =
      (Constants.expoConfig?.extra as any)?.eas?.projectId ?? undefined;
    const expoToken = projectId
      ? (await Notifications.getExpoPushTokenAsync({ projectId })).data
      : (await Notifications.getExpoPushTokenAsync()).data;
    if (!expoToken) return null;
    await fetch(`${API_BASE_URL}/patients/push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ token: expoToken }),
    }).catch(() => {
      // Best-effort: in-app status polling still keeps the patient updated.
    });
    return expoToken;
  } catch {
    return null;
  }
}

export async function addNotificationReceivedListener(
  cb: (notification: any) => void,
): Promise<{ remove(): void }> {
  try {
    await ensureHandler();
    const Notifications = await import('expo-notifications');
    return Notifications.addNotificationReceivedListener(cb);
  } catch {
    return { remove() {} };
  }
}

export async function addNotificationResponseReceivedListener(
  cb: (response: any) => void,
): Promise<{ remove(): void }> {
  try {
    await ensureHandler();
    const Notifications = await import('expo-notifications');
    return Notifications.addNotificationResponseReceivedListener(cb);
  } catch {
    return { remove() {} };
  }
}
