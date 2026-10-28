/* ---------------------------------------------------------------------------
 * The scanner: the back camera, reading QR codes (and the supplier barcodes
 * a drum may carry) straight into the scan screen. The camera sits UNDER the
 * screen's own viewfinder and words, as on the web.
 *
 * `onState` says whether there is a camera at all, so the screen can offer
 * the way round it — pick from photos — instead of a black rectangle.
 * ------------------------------------------------------------------------- */
import { useEffect, useRef } from "react";
import { PermissionsAndroid, Platform, StyleSheet, TextInput, Vibration, type Permission } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";

type Props = {
  torch: boolean;
  paused: boolean;
  onCode: (code: string) => void;
  onState: (s: "live" | "none" | "denied") => void;
};

export function CameraScanner({ torch, paused, onCode, onState }: Props) {
  const [perm, ask] = useCameraPermissions();
  const last = useRef({ code: "", at: 0 });
  /* The screen hands a fresh callback every render; reporting through a ref
     keeps a state report from re-running the effect that made it. */
  const report = useRef(onState);
  useEffect(() => {
    report.current = onState;
  });

  useEffect(() => {
    /* The browser preview (for testing) has no scanner: it takes the screen's no-camera path. */
    if (Platform.OS === "web") return report.current("none");
    if (!perm) return;
    if (perm.granted) report.current("live");
    else if (perm.canAskAgain) void ask();
    else report.current("denied");
  }, [perm, ask]);

  if (Platform.OS === "web" || !perm?.granted) return null;
  return (
    <CameraView
      style={StyleSheet.absoluteFill}
      facing="back"
      enableTorch={torch}
      barcodeScannerSettings={{ barcodeTypes: ["qr", "ean13", "ean8", "code128", "code39"] }}
      onBarcodeScanned={
        paused
          ? undefined
          : ({ data }) => {
              /* The camera reports the same label many times a second; one read is one scan. */
              const now = Date.now();
              if (!data || (data === last.current.code && now - last.current.at < 2500)) return;
              last.current = { code: data, at: now };
              onCode(data.trim());
            }
      }
    />
  );
}

/** A truck photo at a size worth sending over a weak link: 1600 px on the long side, JPEG. */
export async function shrinkPhoto(uri: string, max = 1600): Promise<string> {
  try {
    const r = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: max } }], { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG });
    return r.uri;
  } catch {
    return uri;
  }
}

/* ---------------------------------------------------------------------------
 * A SCANNING GUN IS A KEYBOARD. Paired over Bluetooth it types the label's
 * code and presses Enter, so the scan screen keeps an invisible box focused
 * to catch it — with the on-screen keyboard held shut, because nobody is
 * typing. A gun set to send no Enter, or a Tab, is caught by the pause after
 * the last character: a gun types a whole code in a few milliseconds.
 * ------------------------------------------------------------------------- */

export function GunInput({ onCode }: { onCode: (code: string) => void }) {
  const field = useRef<TextInput>(null);
  const text = useRef("");
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const send = useRef(onCode);
  useEffect(() => {
    send.current = onCode;
  });
  useEffect(() => () => clearTimeout(idle.current), []);

  const flush = () => {
    clearTimeout(idle.current);
    const code = text.current.trim();
    text.current = "";
    field.current?.clear();
    if (code.length >= 3) send.current(code);
  };
  return (
    <TextInput
      ref={field}
      autoFocus
      showSoftInputOnFocus={false}
      caretHidden
      autoCorrect={false}
      autoCapitalize="none"
      autoComplete="off"
      submitBehavior="submit"
      onChangeText={(v) => {
        /* Some guns put the Enter into the text rather than pressing it. */
        if (/[\r\n\t]/.test(v)) {
          text.current = v.split(/[\r\n\t]/)[0];
          return flush();
        }
        text.current = v;
        clearTimeout(idle.current);
        idle.current = setTimeout(flush, 150);
      }}
      onSubmitEditing={flush}
      /* A tap elsewhere takes the focus; the gun needs it back. */
      onBlur={() => setTimeout(() => field.current?.focus(), 200)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", width: 1, height: 1, opacity: 0, left: -10, top: -10 }}
    />
  );
}

/* A buzz says how the scan went without the loader looking at the phone. An
   APK built before VIBRATE was in its manifest cannot buzz at all, and asking
   would throw — so it is checked once and skipped where it is missing. */
let mayBuzz: Promise<boolean> | null = null;
const BUZZ = { ok: [0, 70], warn: [0, 70, 90, 70], bad: [0, 450, 120, 450] };

export function buzz(kind: keyof typeof BUZZ) {
  if (Platform.OS === "web") return void (globalThis as { navigator?: { vibrate?: (p: number[]) => void } }).navigator?.vibrate?.(BUZZ[kind]);
  if (Platform.OS !== "android") return Vibration.vibrate(BUZZ[kind]);
  mayBuzz ??= PermissionsAndroid.check("android.permission.VIBRATE" as Permission).catch(() => false);
  void mayBuzz.then((yes) => {
    if (yes) Vibration.vibrate(BUZZ[kind]);
  });
}
