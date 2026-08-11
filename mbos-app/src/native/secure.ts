import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Secrets — tokens, the device id, the offline credential hash.
 *
 * On a handset these live in the keychain, which is the whole point: a session
 * token in ordinary storage is a session token that survives a backup and
 * leaves the phone with it.
 *
 * `expo-secure-store` has no web implementation, and calling it there throws
 * rather than returning null — which took the entire sign-in down instead of
 * degrading. Web is a preview surface only, never a place real credentials
 * belong, so it falls back to `localStorage` and the fallback says so.
 */

const canUseKeychain = Platform.OS === 'ios' || Platform.OS === 'android';

export async function getSecret(key: string): Promise<string | null> {
  if (canUseKeychain) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      /* A keychain that will not open is not a reason to refuse the app. The
         caller treats a missing secret as "not signed in", which is the safe
         reading and the one that lets the person try again. */
      return null;
    }
  }
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(key);
}

export async function setSecret(key: string, value: string): Promise<void> {
  if (canUseKeychain) {
    try {
      await SecureStore.setItemAsync(key, value);
      return;
    } catch {
      return;
    }
  }
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  if (canUseKeychain) {
    try {
      await SecureStore.deleteItemAsync(key);
      return;
    } catch {
      return;
    }
  }
  if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
}

/** True where secrets are actually protected. The preview surface is not. */
export const secretsAreSecure = canUseKeychain;
