import { Platform, Linking } from 'react-native';
import { apiPost, apiRequest } from './apiClient';
import { savePushToken as persistPushToken, loadPushToken, clearPushToken } from './tokenStore';

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

export async function registerPushToken(): Promise<PushRegistrationResult> {
  try {
    if (Platform.OS === 'web') {
      return { success: false, token: null, permissionStatus: 'web' };
    }
    await ensureHandler();

    const Notifications = await import('expo-notifications');
    const existing = await Notifications.getPermissionsAsync();
    let isGranted = Boolean(existing.granted || existing.status === 'granted');
    let finalStatus = existing.status;
    if (!isGranted) {
      const requested = await Notifications.requestPermissionsAsync();
      finalStatus = requested.status;
      isGranted = Boolean(requested.granted || requested.status === 'granted');
    }

    if (!isGranted) {
      console.warn('Notification permission not granted:', finalStatus);
      return {
        success: false,
        token: null,
        permissionStatus: finalStatus,
        errorMessage: 'Notification permission is disabled in phone settings. Please enable it and tap Refresh.',
      };
    }

    if (Platform.OS === 'android') {
      try {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Visit updates',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#0ea5e9',
          enableVibrate: true,
          enableLights: true,
          showBadge: true,
        });
      } catch (chanErr: any) {
        console.warn('setNotificationChannelAsync notice:', chanErr?.message);
      }
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
      return {
        success: false,
        token: null,
        permissionStatus: finalStatus,
        errorMessage: 'Failed to retrieve push token from notification service',
      };
    }

    await apiPost('/patients/push-token', {
      token: expoToken,
      platform: Platform.OS,
    });
    await persistPushToken(expoToken);

    console.log('Push token registered successfully');

    return {
      success: true,
      token: expoToken,
      permissionStatus: finalStatus,
    };
  } catch (e: any) {
    console.warn('registerPushToken error:', e?.message ?? e);
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
 * Returns the notification the app was launched from, if any.
 *
 * A response listener only fires for taps while the app is running; a tap that
 * cold-starts the app has to be read back explicitly or the user lands on the
 * home screen and the referenced record is never opened.
 */
export async function getInitialNotificationResponse(): Promise<any | null> {
  try {
    if (Platform.OS === 'web') return null;
    const Notifications = await import('expo-notifications');
    if (typeof Notifications.getLastNotificationResponseAsync !== 'function') return null;
    return await Notifications.getLastNotificationResponseAsync();
  } catch {
    return null;
  }
}

/**
 * Deactivates this device's push token for the signed-in account.
 * Call before clearing the session on logout / account switch so the next
 * account on this phone does not receive the previous user's notifications.
 * Best effort: offline logout still proceeds.
 */
export async function unregisterPushToken(): Promise<boolean> {
  try {
    if (Platform.OS === 'web') return false;
    const token = await loadPushToken();
    await apiRequest('/patients/push-token', {
      method: 'DELETE',
      json: token ? { token } : {},
    });
    await clearPushToken();
    return true;
  } catch (e: any) {
    console.warn('unregisterPushToken error:', e?.message ?? e);
    return false;
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
export async function testServerPush(): Promise<{ success: boolean; message: string }> {
  try {
    const data = await apiPost<{ message?: string }>('/patients/test-push');
    return {
      success: true,
      message: data?.message || 'Test notification sent from server!',
    };
  } catch (e: any) {
    return {
      success: false,
      message: e?.message || 'Network error reaching Hepziba server',
    };
  }
}
