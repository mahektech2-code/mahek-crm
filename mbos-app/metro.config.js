// Expo's default Metro config, plus one development-only switch.
//
// `EXPO_GO=1 npx expo start` swaps MapLibre for `dev/maplibre-expo-go.tsx`,
// because Expo Go has no MapLibre native code and the real package throws on
// import. Without the variable — every real build, the APK workflow, EAS
// Update — this resolves exactly as Expo's default does.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (process.env.EXPO_GO === '1') {
  const stub = path.resolve(__dirname, 'dev/maplibre-expo-go.tsx');
  const resolve = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === '@maplibre/maplibre-react-native') return { type: 'sourceFile', filePath: stub };
    return (resolve ?? context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = config;
