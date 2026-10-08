import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { plan, shouldFire, type FeedbackKind, type SoundName } from '../../engines/feedback';
import { feedbackPrefs } from '../../data/feedback-prefs';
import { ringerMode } from '../../native/phone-setup';

/**
 * The one door to the vibration motor and the speaker.
 *
 * Screens call `feedback('success')` and nothing else — never `expo-haptics`,
 * never `expo-audio` for a UI sound. `engines/feedback.ts` decides WHETHER;
 * this file only does what it decided. `motion-guard.test.ts` fails the build
 * on an import of either library outside `components/ui/`.
 *
 * IT NEVER THROWS AND NEVER WAITS. A buzz that fails is a buzz not felt; it
 * must not become a save that failed. Everything below is fire-and-forget and
 * swallows its own errors.
 */

/* ---------------------------------------------------------------- haptics */

/**
 * EXPO-HAPTICS IS LOADED LAZILY, AND ONLY WHERE ITS NATIVE HALF EXISTS.
 *
 * It arrived with 1.16.0. Every APK before that has no `ExpoHaptics` in it,
 * and `expo-haptics` calls `requireNativeModule` the moment it is imported —
 * which THROWS. A top-level import would therefore make this file, and every
 * screen that buzzes, crash on the 1.15.0 phones the moment main's JavaScript
 * reached them over the air; and main's JavaScript does reach older runtimes,
 * deliberately, see DEPLOY.md "Shipping to the handset without reinstalling
 * it". So the native half is asked for first, and the library is required
 * only once it is known to be there. On an older build the answer is no
 * buzz, which is what that build always did.
 *
 * There is no `Vibration` fallback: those builds carry no VIBRATE permission,
 * and a vibrator call without it is a SecurityException in native code.
 */
type HapticsModule = typeof import('expo-haptics');
let haptics: Promise<HapticsModule | null> | null = null;

/* Imported the way `native/capture.ts` imports the document picker — on
   first use, and only once the native half is known to be in this APK. */
function loadHaptics(): Promise<HapticsModule | null> {
  if (!haptics) {
    haptics = requireOptionalNativeModule('ExpoHaptics')
      ? import('expo-haptics').catch(() => null)
      : Promise.resolve(null);
  }
  return haptics;
}

/**
 * ANDROID GETS ITS OWN CONSTANTS, deliberately.
 *
 * `performAndroidHapticsAsync` goes through `View.performHapticFeedback`, which
 * is the system's own touch-feedback channel: it respects the phone's "touch
 * vibration" setting, uses whatever the manufacturer tuned for that phone's
 * motor, and needs no permission. The cross-platform `notificationAsync` drives
 * the vibrator directly — a cruder buzz, and one that ignores the person's
 * own setting. `Confirm` and `Reject` need Android 11; on older phones the
 * system plays a plain click, which is still right.
 */
function androidHaptic(Haptics: HapticsModule, kind: FeedbackKind): HapticsModule['AndroidHaptics'][keyof HapticsModule['AndroidHaptics']] {
  switch (kind) {
    case 'success':
      return Haptics.AndroidHaptics.Confirm;
    case 'warning':
    case 'error':
      return Haptics.AndroidHaptics.Reject;
    case 'select':
      return Haptics.AndroidHaptics.Segment_Tick;
    case 'tap':
      return Haptics.AndroidHaptics.Context_Click;
    case 'arrive':
      return Haptics.AndroidHaptics.Long_Press;
  }
}

async function buzz(kind: FeedbackKind): Promise<void> {
  const Haptics = await loadHaptics();
  if (!Haptics) return;
  try {
    if (Platform.OS === 'android') {
      await Haptics.performAndroidHapticsAsync(androidHaptic(Haptics, kind));
      return;
    }
    if (kind === 'success') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === 'warning') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else if (kind === 'error') await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    else if (kind === 'select') await Haptics.selectionAsync();
    else if (kind === 'tap') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {
    /* No motor, a web build, or a module from a different APK. Felt nothing. */
  }
}

/* ------------------------------------------------------------------ sound */

const SOURCES: Record<SoundName, number> = {
  ui_success: require('../../../assets/sounds/ui_success.wav'),
  ui_warning: require('../../../assets/sounds/ui_warning.wav'),
  ui_error: require('../../../assets/sounds/ui_error.wav'),
  ui_arrive: require('../../../assets/sounds/ui_arrive.wav'),
};

/**
 * One player per sound, made on first use and kept.
 *
 * Making a player decodes the file; doing that at the moment of the event puts
 * the chime a beat behind the thing it is confirming, which is exactly when it
 * stops reading as caused by it. Four tiny players held for the life of the
 * process cost nothing.
 *
 * A chime never changes the audio mode from under a recording — the
 * dictation recorder owns it while it runs. What it does do is say, once at
 * start and again whenever a recording ends (`restoreUiAudioMode`), that these
 * sounds MIX with whatever else is playing. The default asks Android for audio
 * focus, which pauses the map app's voice guidance for every save chime — the
 * one thing a salesman on a bike is actually listening to.
 */
const players = new Map<SoundName, AudioPlayer>();

function player(name: SoundName): AudioPlayer | null {
  try {
    let p = players.get(name);
    if (!p) {
      p = createAudioPlayer(SOURCES[name]);
      p.volume = 0.6;
      players.set(name, p);
    }
    return p;
  } catch {
    return null;
  }
}

async function chime(name: SoundName): Promise<void> {
  const p = player(name);
  if (!p) return;
  try {
    await p.seekTo(0);
    p.play();
  } catch {
    /* Audio focus refused, a call in progress — heard nothing. */
  }
}

/**
 * Warm the players before the first event, so even the first chime of the day
 * lands on time. Only when sounds are switched on: a decoder kept warm for a
 * sound nobody will hear is waste.
 */
/**
 * The audio mode the app's own sounds want, put back after a recording.
 *
 * The recorder sets `allowsRecording` and `duckOthers` while the microphone is
 * open, and nothing ever set them back — so after one dictated note, every
 * later chime ducked the music and, on iOS, could route to the earpiece. Only
 * called where no recording can be running: at start, and as a dictation sheet
 * closes.
 */
export async function restoreUiAudioMode(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: false,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'mixWithOthers',
    });
  } catch {
    /* A phone that will not take it plays the chime with its default focus,
       which is what every build before this did. */
  }
}

export function primeSounds(): void {
  void loadHaptics();
  void restoreUiAudioMode();
  if (!feedbackPrefs().sounds) return;
  (Object.keys(SOURCES) as SoundName[]).forEach((n) => player(n));
}

/* ------------------------------------------------------------------- door */

let last: { kind: FeedbackKind; at: number } | null = null;

export function feedback(kind: FeedbackKind): void {
  const now = Date.now();
  if (!shouldFire(kind, last, now)) return;
  last = { kind, at: now };

  const prefs = feedbackPrefs();
  if (!prefs.haptics && !prefs.sounds) return;

  /* THE BUZZ NEVER WAITS, and follows one rule whether sounds are on or off:
     it goes through `performHapticFeedback`, which already honours the
     phone's own touch-feedback setting, so it is decided without asking the
     ringer. Only the SOUND waits on the ringer query — a native round trip —
     and only when sounds are on at all. */
  const { haptic } = plan(kind, prefs, 'normal');
  if (haptic) void buzz(haptic);
  if (!prefs.sounds) return;

  void (async () => {
    const { sound } = plan(kind, prefs, await ringerMode());
    if (sound) await chime(sound);
  })();
}
