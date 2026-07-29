import { StyleSheet } from 'react-native';

export function createStyles<T extends Record<string, unknown>>(styles: T): T {
  const create = (StyleSheet as { create?: <U extends T>(value: U) => U }).create;
  return typeof create === 'function' ? create(styles) : styles;
}