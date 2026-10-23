import { Platform } from 'react-native';
import { API_BASE_URL } from '../config/api';

// NOTE: expo-device / expo-notifications are imported lazily inside the
// functions below so the web bundle (which has no ExpoDevice native module)
// never evaluates them at load time.

// Foreground presentation: show a banner and play sound even while the app is open.
let handlerSet = false;
export async function ensureHandler() {
  if (handlerSet || Platform.OS === 'web') return;
  try {
    const Notifications = await import('expo-notifications');
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPresentAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    handlerSet = true;
  } catch (e) {
    // Notifications unavailable — in-app polling still applies.
    console.warn('ensureHandler could not initialize:', e);
  }
}

// Ensure handler is initialized early on native platforms
if (Platform.OS !== 'web') {
  void ensureHandler();
}

export async function registerPushToken(authToken: string): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return null;
    await ensureHandler();

    const Device = await import('expo-device');
    if (!Device.isDevice) {
      console.warn('Push notifications require a physical device');
      return null;
    }

    const Notifications = await import('expo-notifications');
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.warn('Notification permission not granted:', finalStatus);
      return null;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Visit updates',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#0ea5e9',
        enableVibrate: true,
        enableLights: true,
        showBadge: true,
      });
    }

    const Constants = (await import('expo-constants')).default;
    const projectId =
      (Constants.expoConfig?.extra as any)?.eas?.projectId ??
      (Constants as any).easConfig?.projectId ??
      'd9eccdd8-3b4e-4a8d-8728-56d779c7fa1b';

    const tokenResponse = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    const expoToken = tokenResponse?.data;

    if (!expoToken) {
      console.warn('No Expo push token obtained');
      return null;
    }

    const res = await fetch(`${API_BASE_URL}/patients/push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ token: expoToken }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('Backend failed to save push token:', res.status, errText);
    } else {
      console.log('Push token registered successfully:', expoToken);
    }

    return expoToken;
  } catch (e) {
    console.warn('registerPushToken error:', e);
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

/**
 * Triggers an immediate local test notification on device.
 * Tests channel configuration, heads-up banner presentation, vibration, and sound.
 */
export async function sendLocalTestNotification(
  title = 'Hepziba Clinic',
  body = 'Test Notification: Visit notifications are configured and working properly!',
): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      console.log('Local notifications are not supported on web.');
      return;
    }
    await ensureHandler();
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: 'default',
        data: { test: true },
      },
      trigger: { channelId: 'default' },
    });
    console.log('Local test notification triggered.');
  } catch (e) {
    console.warn('sendLocalTestNotification error:', e);
  }
}
