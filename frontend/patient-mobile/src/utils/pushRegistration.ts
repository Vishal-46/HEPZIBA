import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { API_BASE_URL } from '../config/api';

// Foreground presentation: show a banner even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPresentAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerPushToken(authToken: string): Promise<string | null> {
  try {
    if (!Device.isDevice) return null;
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

export { Notifications };
