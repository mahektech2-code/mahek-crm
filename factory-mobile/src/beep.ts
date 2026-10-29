/* ---------------------------------------------------------------------------
 * A SCANNER BEEPS. A loader with a drum in both hands is not looking at the
 * phone, and on a factory floor a buzz in a pocket is easy to miss — so the
 * answer is said out loud as well, the way a shop's barcode gun says it: one
 * short high beep for taken, a double chirp for taken-with-a-warning, a low
 * harsh triple for refused. Nobody has to learn which is which.
 *
 * The players are made ONCE and kept, so a beep costs a seek and a play —
 * milliseconds — and lands with the answer rather than after it. Loading a
 * file per scan would put a decode between the server's yes and the sound.
 *
 * An APK built before expo-audio was in it has no native module, and its
 * import throws at load — which would take the whole app with it. The OTA
 * runtime is the app version, so new JS should never reach an old binary;
 * this asks anyway, and an old build simply stays silent and still buzzes.
 * ------------------------------------------------------------------------- */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import type { Tone } from "./scan-sound";

type Player = { seekTo: (s: number) => Promise<void>; play: () => void; volume: number };

const FILES: Record<Tone, number> = {
  ok: require("../assets/sounds/scan-ok.wav"),
  warn: require("../assets/sounds/scan-warn.wav"),
  bad: require("../assets/sounds/scan-bad.wav"),
};

let players: Record<Tone, Player> | null | undefined;

function load(): Record<Tone, Player> | null {
  if (players !== undefined) return players;
  players = null;
  try {
    if (Platform.OS !== "web" && !requireOptionalNativeModule("ExpoAudio")) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const audio = require("expo-audio") as typeof import("expo-audio");
    /* Mixed in, never taking the audio focus: a spoken refusal must not be cut off by its own beep. */
    void audio.setAudioModeAsync({ playsInSilentMode: true, interruptionMode: "mixWithOthers", shouldPlayInBackground: false }).catch(() => {});
    const make = (t: Tone) => {
      const p = audio.createAudioPlayer(FILES[t]);
      p.volume = 1;
      return p;
    };
    players = { ok: make("ok"), warn: make("warn"), bad: make("bad") };
  } catch {
    players = null;
  }
  return players;
}

/** Made at start-up rather than at the first scan, so the first beep is as quick as the hundredth. */
export function warmBeeps() {
  load();
}

export function beep(tone: Tone) {
  const p = load()?.[tone];
  if (!p) return;
  try {
    /* From the top every time: two scans a second apart must both be heard whole. */
    const go = () => p.play();
    void p.seekTo(0).then(go, go);
  } catch {
    /* No sound is never a reason to lose a scan: the buzz and the card still say it. */
  }
}
