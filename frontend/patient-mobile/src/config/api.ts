import { Platform } from 'react-native';

const envBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

export const API_BASE_URL =
  envBaseUrl || (Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000');
