// The Factory app shares its RULES with the server, not a copy of them.
//
// `@/lib/factory/rules`, `types` and `i18n` are the same pure files the
// server checks every submission against, read from ../src. Copying them in
// would be two answers to "is this scan allowed" that drift within a release.
// Only pure, client-safe modules may be imported this way: nothing here can
// load a database driver or `server-only`.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const SRC = path.resolve(__dirname, "..", "src");

config.watchFolders = [path.join(SRC, "lib")];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@/")) {
    return context.resolveRequest(context, path.join(SRC, moduleName.slice(2)), platform);
  }
  return (resolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
