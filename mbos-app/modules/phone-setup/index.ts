import { requireOptionalNativeModule } from 'expo';

/**
 * The bridge, and nothing else.
 *
 * This file is the native module as it actually is: four launchers and one
 * query, each of which can be absent. Everything a screen should touch —
 * the platform guards, the never-reject promise, the honest `'unknown'` —
 * lives one file over in `src/native/phone-setup.ts`. Two files because the
 * thing that can be missing and the thing that is guaranteed to answer are
 * different objects, and a screen importing this one would be importing the
 * half that can be `null`.
 *
 * **THIS IS THE FIRST LOCAL MODULE IN THIS PROJECT**, so it is also the
 * pattern. The project is CNG — there is no committed `android/`, and CI runs
 * `npx expo prebuild --platform android --no-install` (see
 * `.github/workflows/mbos-apk.yml`) — which means a directory under
 * `mbos-app/modules/` carrying an `expo-module.config.json` is autolinked at
 * prebuild with nothing else to wire up. `./modules` is autolinking's own
 * default `nativeModulesDir`; a local module needs no `package.json` and no
 * entry in the app's own.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`, which
 * THROWS when the native half is not in the binary. That is not a theoretical
 * state here: the module arrives in a new APK, and sideloading has no staged
 * rollout — a handset in somebody's pocket goes on running the build it has
 * until a person installs the next one. A phone-setup screen that crashed on
 * the older build would be the worst possible version of a feature whose
 * entire job is to help somebody whose phone is already misbehaving.
 */

export type NativePhoneSetupModule = {
  batteryExemption(): Promise<string>;
  requestBatteryExemption(): Promise<string>;
  openAutostartSettings(): Promise<string>;
  openAppSettings(): Promise<boolean>;
  openLocationSettings(): Promise<boolean>;
};

/** `null` on iOS, on web, and on any build that predates the module. */
export const PhoneSetup = requireOptionalNativeModule<NativePhoneSetupModule>('MbosPhoneSetup');
