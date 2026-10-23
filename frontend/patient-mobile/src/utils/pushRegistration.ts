import { Platform, Linking } from 'react-native';
import { API_BASE_URL } from '../config/api';

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
    console.warn('ensureHandler could not initialize:', e);
  }
}

// Ensure handler is initialized early on native platforms
if (Platform.OS !== 'web') {
  void ensureHandler();
}

export type PushRegistrationResult = {
  success: boolean;
  token: string | null;
  permissionStatus: string;
  errorMessage?: string;
};

export async function checkNotificationPermission(): Promise<{ granted: boolean; status: string }> {
  if (Platform.OS === 'web') return { granted: false, status: 'web' };
  try {
    const Notifications = await import('expo-notifications');
    const { status } = await Notifications.getPermissionsAsync();
    return { granted: status === 'granted', status };
  } catch {
    return { granted: false, status: 'unavailable' };
  }
}

export async function openNotificationSettings(): Promise<void> {
  try {
    if (Platform.OS === 'android' || Platform.OS === 'ios') {
      await Linking.openSettings();
    }
  } catch (e) {
    console.warn('Could not open settings:', e);
  }
}

export async function registerPushToken(authToken: string): Promise<PushRegistrationResult> {
  try {
    if (Platform.OS === 'web') {
      return { success: false, token: null, permissionStatus: 'web' };
    }
    await ensureHandler();

    const Device = await import('expo-device');
    if (!Device.isDevice) {
      console.warn('Push notifications require a physical device');
      return {
        success: false,
        token: null,
        permissionStatus: 'simulator',
        errorMessage: 'Push notifications require a physical device',
      };
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
      return {
        success: false,
        token: null,
        permissionStatus: finalStatus,
        errorMessage: 'Notification permission was denied. Please allow notifications in device settings.',
      };
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
      return {
        success: false,
        token: null,
        permissionStatus: finalStatus,
        errorMessage: 'Failed to retrieve push token from notification service',
      };
    }

    const res = await fetch(`${API_BASE_URL}/patients/push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ token: expoToken }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('Backend failed to save push token:', res.status, errText);
      return {
        success: false,
        token: expoToken,
        permissionStatus: finalStatus,
        errorMessage: `Server failed to save push token (status: ${res.status})`,
      };
    }

    console.log('Push token registered successfully:', expoToken);
    return {
      success: true,
      token: expoToken,
      permissionStatus: finalStatus,
    };
  } catch (e: any) {
    console.warn('registerPushToken error:', e);
    return {
      success: false,
      token: null,
      permissionStatus: 'error',
      errorMessage: e?.message || 'Unknown error occurred while registering push token',
    };
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
): Promise<boolean> {
  try {
    if (Platform.OS === 'web') {
      console.log('Local notifications are not supported on web.');
      return false;
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
    return true;
  } catch (e) {
    console.warn('sendLocalTestNotification error:', e);
    return false;
  }
}

/**
 * Triggers a backend-initiated push notification through the server -> Expo -> FCM pipeline.
 */
export async function testServerPush(
  authToken: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/patients/test-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        message: data.error || `Server returned error (${res.status})`,
      };
    }
    return {
      success: true,
      message: data.message || 'Test notification sent from server!',
    };
  } catch (e: any) {
    return {
      success: false,
      message: e?.message || 'Network error reaching Hepziba server',
    };
  }
}
