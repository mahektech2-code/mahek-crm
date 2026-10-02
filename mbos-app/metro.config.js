// Expo's default Metro config, plus one development-only switch.
//
// `EXPO_GO=1 npx expo start` swaps two packages for stand-ins in `dev/`,
// because Expo Go cannot run them and both throw on import there:
//   - MapLibre, whose native code Expo Go does not carry;
//   - expo-notifications, whose Android push Expo Go removed in SDK 53 and
//     whose import throws from SDK 57.
// Without the variable — every real build, the APK workflow, EAS Update —
// this resolves exactly as Expo's default does.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (process.env.EXPO_GO === '1') {
  const stubs = {
    '@maplibre/maplibre-react-native': path.resolve(__dirname, 'dev/maplibre-expo-go.tsx'),
    'expo-notifications': path.resolve(__dirname, 'dev/notifications-expo-go.ts'),
  };
  const resolve = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (stubs[moduleName]) return { type: 'sourceFile', filePath: stubs[moduleName] };
    return (resolve ?? context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = config;
