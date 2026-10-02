/**
 * EXPO-NOTIFICATIONS, FOR EXPO GO ONLY — swapped in by `metro.config.js` when
 * the bundler is started with `EXPO_GO=1`, and never part of a real build.
 *
 * Expo Go dropped Android push in SDK 53, and from SDK 57 merely importing
 * the package throws there. MBOS imports it on the startup path (the sync
 * engine's left-shop reminder), so the root layout failed to load and every
 * route reported "missing the required default export". This stands in for
 * the calls MBOS makes: permission reads answer granted so no setup screen
 * nags about a module that is not there, a push token is refused (the caller
 * already catches that), and everything else does nothing.
 */

const noop = () => {};
const granted = async () => ({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' });

export const AndroidImportance = { MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 } as const;
export const AndroidNotificationPriority = { MIN: 'min', LOW: 'low', DEFAULT: 'default', HIGH: 'high', MAX: 'max' } as const;

export const setNotificationHandler = noop;
export const setNotificationChannelAsync = async () => null;
export const getPermissionsAsync = granted;
export const requestPermissionsAsync = granted;
export const scheduleNotificationAsync = async () => 'expo-go';
export const getLastNotificationResponseAsync = async () => null;
export const addNotificationResponseReceivedListener = () => ({ remove: noop });
export const getExpoPushTokenAsync = async (): Promise<{ data: string }> => {
  throw new Error('Push notifications are not available in Expo Go.');
};
