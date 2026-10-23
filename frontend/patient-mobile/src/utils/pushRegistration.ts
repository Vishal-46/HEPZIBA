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

// Fire-and-forget telemetry ping to backend so we can inspect live device status in /debug-push
async function sendTelemetry(data: Record<string, any>): Promise<void> {
  try {
    if (Platform.OS === 'web') return;
    await fetch(`${API_BASE_URL}/push-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        platform: Platform.OS,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (_) {
    // telemetry failure never breaks the app
  }
}

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
  let isPhysDevice = true;
  let deviceName = 'unknown';

  try {
    if (Platform.OS === 'web') {
      return { success: false, token: null, permissionStatus: 'web' };
    }
    await ensureHandler();

    try {
      const Device = await import('expo-device');
      isPhysDevice = !!Device.isDevice;
      deviceName = `${Device.brand || ''} ${Device.modelName || ''}`.trim() || 'Android Device';
    } catch (_) {}

    await sendTelemetry({ stage: 'start', isPhysDevice, deviceName });

    const Notifications = await import('expo-notifications');
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    await sendTelemetry({ stage: 'permission_checked', finalStatus, isPhysDevice });

    if (finalStatus !== 'granted') {
      console.warn('Notification permission not granted:', finalStatus);
      await sendTelemetry({ stage: 'permission_denied', finalStatus });
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

    let tokenResponse = null;
    try {
      tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    } catch (easErr: any) {
      console.warn('getExpoPushTokenAsync with projectId error, retrying without:', easErr?.message);
      try {
        tokenResponse = await Notifications.getExpoPushTokenAsync();
      } catch (fallbackErr: any) {
        console.error('All getExpoPushTokenAsync attempts failed:', fallbackErr);
        await sendTelemetry({
          stage: 'token_error',
          easError: easErr?.message,
          fallbackError: fallbackErr?.message,
        });
        return {
          success: false,
          token: null,
          permissionStatus: finalStatus,
          errorMessage: `Push token error: ${fallbackErr?.message || easErr?.message}`,
        };
      }
    }

    const expoToken = tokenResponse?.data;
    if (!expoToken) {
      console.warn('No Expo push token obtained');
      await sendTelemetry({ stage: 'token_empty' });
      return {
        success: false,
        token: null,
        permissionStatus: finalStatus,
        errorMessage: 'Failed to retrieve push token from notification service',
      };
    }

    await sendTelemetry({ stage: 'token_obtained', tokenPrefix: expoToken.slice(0, 20) });

    const res = await fetch(`${API_BASE_URL}/patients/push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ token: expoToken }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('Backend failed to save push token:', res.status, errText);
      await sendTelemetry({ stage: 'backend_save_failed', status: res.status, errText });
      return {
        success: false,
        token: expoToken,
        permissionStatus: finalStatus,
        errorMessage: `Server failed to save push token (status: ${res.status})`,
      };
    }

    console.log('Push token registered successfully:', expoToken);
    await sendTelemetry({ stage: 'registered_successfully', token: expoToken });

    return {
      success: true,
      token: expoToken,
      permissionStatus: finalStatus,
    };
  } catch (e: any) {
    console.warn('registerPushToken error:', e);
    await sendTelemetry({ stage: 'unexpected_error', error: e?.message });
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
