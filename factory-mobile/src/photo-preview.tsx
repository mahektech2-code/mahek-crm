/* ---------------------------------------------------------------------------
 * A PHOTO BEFORE IT IS SENT, full screen: step through the tray, and crop,
 * rotate or take one out. Nothing is typed here — the phone only uploads, and
 * the office checks every copy on the Documents desk — so this is only ever
 * about the picture. Crop and rotate write a new file on the phone with
 * expo-image-manipulator; the tray then holds that one instead.
 * ------------------------------------------------------------------------- */
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Modal, PanResponder, Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
import { ic } from "./art";

type Box = { x: number; y: number; w: number; h: number };
const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
const MIN = 0.1;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function PhotoPreview({
  uris,
  at,
  locked,
  onAt,
  onReplace,
  onRemove,
  onClose,
}: {
  uris: string[];
  at: number;
  /** While the tray is sending, nothing may change. */
  locked: boolean;
  onAt: (i: number) => void;
  onReplace: (i: number, uri: string) => void;
  onRemove: (i: number) => void;
  onClose: () => void;
}) {
  const uri = uris[at];
  const [cropping, setCropping] = useState(false);
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    if (busy || locked) return;
    setBusy(true);
    try {
      const r = await ImageManipulator.manipulateAsync(uri, [{ rotate: 90 }], { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });
      onReplace(at, r.uri);
    } finally {
      setBusy(false);
    }
  };

  const tool = (icon: string, label: string, run: () => void, danger = false) => (
    <Pressable onPress={run} disabled={busy || locked} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} style={{ width: 64, height: 56, alignItems: "center", justifyContent: "center", opacity: busy || locked ? 0.4 : 1 }}>
      {ic(icon, 26, danger ? "#FF9A8F" : "#E6E8EC")}
    </Pressable>
  );

  return (
    <Modal visible animationType="fade" onRequestClose={() => (cropping ? setCropping(false) : onClose())} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "#0F1114" }}>
        {cropping ? (
          <Cropper
            uri={uri}
            onCancel={() => setCropping(false)}
            onDone={(u) => {
              setCropping(false);
              onReplace(at, u);
            }}
          />
        ) : (
          <>
            <View style={{ paddingTop: 44, paddingHorizontal: 8, flexDirection: "row", alignItems: "center" }}>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
                {ic("x", 24, "#FFFFFF")}
              </Pressable>
              <Text style={{ flex: 1, textAlign: "center", color: "#FFFFFF", fontSize: 16, fontWeight: "700" }}>{at + 1 + " of " + uris.length}</Text>
              <View style={{ width: 48 }} />
            </View>
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
              <Pressable onPress={() => at > 0 && onAt(at - 1)} disabled={at === 0} accessibilityLabel="Previous" style={{ width: 44, height: 120, alignItems: "center", justifyContent: "center", opacity: at === 0 ? 0.2 : 1 }}>
                {ic("back", 26, "#FFFFFF")}
              </Pressable>
              <Image source={{ uri }} style={{ flex: 1, height: "92%" }} resizeMode="contain" />
              <Pressable onPress={() => at < uris.length - 1 && onAt(at + 1)} disabled={at >= uris.length - 1} accessibilityLabel="Next" style={{ width: 44, height: 120, alignItems: "center", justifyContent: "center", opacity: at >= uris.length - 1 ? 0.2 : 1 }}>
                {ic("chev", 26, "#FFFFFF")}
              </Pressable>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-around", paddingTop: 6, paddingBottom: 30, borderTopWidth: 1, borderTopColor: "#22262D" }}>
              {tool("crop", "Crop", () => setCropping(true))}
              {tool("rotate", "Rotate", () => void rotate())}
              {tool("bin", "Remove", () => onRemove(at), true)}
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

/** Drag the box, or its corners; Save cuts the photo to it. */
function Cropper({ uri, onCancel, onDone }: { uri: string; onCancel: () => void; onDone: (uri: string) => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [area, setArea] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<Box>(FULL);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(box);
  useEffect(() => {
    boxRef.current = box;
  }, [box]);

  useEffect(() => {
    Image.getSize(uri, (w, h) => setSize({ w, h }), () => setSize(null));
  }, [uri]);

  /* The photo as drawn: fitted into the area, centred. */
  const fit = useMemo(() => {
    if (!size || !area) return null;
    const s = Math.min(area.w / size.w, area.h / size.h);
    const w = size.w * s;
    const h = size.h * s;
    return { w, h, left: (area.w - w) / 2, top: (area.h - h) / 2 };
  }, [size, area]);
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  const mover = (mode: "move" | "tl" | "tr" | "bl" | "br") => {
    let start = FULL;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start = boxRef.current;
      },
      onPanResponderMove: (_e, g) => {
        const f = fitRef.current;
        if (!f) return;
        const dx = g.dx / f.w;
        const dy = g.dy / f.h;
        const s = start;
        if (mode === "move") return setBox({ ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) });
        let { x, y, w, h } = s;
        if (mode === "tl" || mode === "bl") {
          const nx = clamp(s.x + dx, 0, s.x + s.w - MIN);
          w = s.w + (s.x - nx);
          x = nx;
        } else w = clamp(s.w + dx, MIN, 1 - s.x);
        if (mode === "tl" || mode === "tr") {
          const ny = clamp(s.y + dy, 0, s.y + s.h - MIN);
          h = s.h + (s.y - ny);
          y = ny;
        } else h = clamp(s.h + dy, MIN, 1 - s.y);
        setBox({ x, y, w, h });
      },
    });
  };
  /* Made once: a responder rebuilt every render drops the finger mid-drag. */
  const pans = useMemo(() => ({ move: mover("move"), tl: mover("tl"), tr: mover("tr"), bl: mover("bl"), br: mover("br") }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!size || busy) return;
    setBusy(true);
    try {
      const crop = { originX: Math.round(box.x * size.w), originY: Math.round(box.y * size.h), width: Math.max(1, Math.round(box.w * size.w)), height: Math.max(1, Math.round(box.h * size.h)) };
      const r = await ImageManipulator.manipulateAsync(uri, [{ crop }], { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });
      onDone(r.uri);
    } finally {
      setBusy(false);
    }
  };

  const onLayout = (e: LayoutChangeEvent) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const handle = { position: "absolute" as const, width: 26, height: 26, borderRadius: 13, backgroundColor: "#FFFFFF", borderWidth: 3, borderColor: "#8B6CFF" };

  return (
    <>
      <View style={{ paddingTop: 44, paddingHorizontal: 12, flexDirection: "row", alignItems: "center" }}>
        <Pressable onPress={onCancel} accessibilityRole="button" style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 6 }}>
          <Text style={{ color: "#FFFFFF", fontSize: 16 }}>Cancel</Text>
        </Pressable>
        <Text style={{ flex: 1, textAlign: "center", color: "#FFFFFF", fontSize: 16, fontWeight: "700" }}>Crop</Text>
        <Pressable onPress={() => void save()} disabled={busy} accessibilityRole="button" style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 6, opacity: busy ? 0.5 : 1 }}>
          <Text style={{ color: "#B9A6FF", fontSize: 16, fontWeight: "700" }}>{busy ? "Saving…" : "Save"}</Text>
        </Pressable>
      </View>
      <View style={{ flex: 1, margin: 16 }} onLayout={onLayout}>
        {fit ? (
          <View style={{ position: "absolute", left: fit.left, top: fit.top, width: fit.w, height: fit.h }}>
            <Image source={{ uri }} style={{ width: fit.w, height: fit.h }} />
            <View
              {...pans.move.panHandlers}
              style={{ position: "absolute", left: box.x * fit.w, top: box.y * fit.h, width: box.w * fit.w, height: box.h * fit.h, borderWidth: 2, borderColor: "#8B6CFF", backgroundColor: "rgba(139,108,255,0.08)" }}
            >
              <View {...pans.tl.panHandlers} style={{ ...handle, left: -13, top: -13 }} />
              <View {...pans.tr.panHandlers} style={{ ...handle, right: -13, top: -13 }} />
              <View {...pans.bl.panHandlers} style={{ ...handle, left: -13, bottom: -13 }} />
              <View {...pans.br.panHandlers} style={{ ...handle, right: -13, bottom: -13 }} />
            </View>
          </View>
        ) : null}
      </View>
      <View style={{ alignItems: "center", paddingBottom: 30 }}>
        <Pressable onPress={() => setBox(FULL)} accessibilityRole="button" accessibilityLabel="Reset" style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 16 }}>
          <Text style={{ color: "#E6E8EC", fontSize: 15, fontWeight: "600" }}>Reset</Text>
        </Pressable>
      </View>
    </>
  );
}
