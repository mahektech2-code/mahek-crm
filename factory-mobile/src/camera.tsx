/* ---------------------------------------------------------------------------
 * The scanner: the back camera, reading QR codes (and the supplier barcodes
 * a drum may carry) straight into the scan screen. The camera sits UNDER the
 * screen's own viewfinder and words, as on the web.
 *
 * `onState` says whether there is a camera at all, so the screen can offer
 * the way round it — pick from photos — instead of a black rectangle.
 * ------------------------------------------------------------------------- */
import { useEffect, useRef } from "react";
import { Platform, StyleSheet } from "react-native";
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
