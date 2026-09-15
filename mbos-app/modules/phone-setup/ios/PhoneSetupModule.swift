import ExpoModulesCore

/**
 NONE OF THIS EXISTS ON iOS, and the honest thing is to say so rather than
 leave an empty file.

 There is no battery-optimisation exemption to ask for: iOS manages
 background execution itself, an app cannot request to be left alone, and
 nothing equivalent to `PowerManager.isIgnoringBatteryOptimizations` is
 exposed. There is no autostart list, because there is no OEM battery manager
 killing foreground services — the problem this module was written for is
 specifically an Android-OEM problem. `UIApplication.openSettingsURLString`
 would open this app's own settings page, but it is a different screen
 answering a different question, and offering it here would let a caller
 believe it had opened something it had not.

 So every function answers with the same word it would answer on an Android
 that refused the query: `unknown`, and `false`. A caller that treats the two
 platforms alike gets a correct, useless answer on iOS instead of a crash,
 which is the whole contract.

 MBOS ships on Android only today — the APK workflow is the entire
 distribution story, see DEPLOY.md. This file exists so that `expo prebuild
 --platform ios` does not fall over the day somebody tries it, and so that
 `apple` in expo-module.config.json is not a claim about a platform with no
 implementation behind it.
 */
public class PhoneSetupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MbosPhoneSetup")

    AsyncFunction("batteryExemption") { () -> String in
      return "unknown"
    }

    AsyncFunction("requestBatteryExemption") { () -> String in
      return "unknown"
    }

    AsyncFunction("openAutostartSettings") { () -> String in
      return "failed"
    }

    AsyncFunction("openAppSettings") { () -> Bool in
      return false
    }

    AsyncFunction("openLocationSettings") { () -> Bool in
      return false
    }
  }
}
