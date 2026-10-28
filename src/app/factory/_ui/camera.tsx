"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/* ---------------------------------------------------------------------------
 * The camera behind the scan frame.
 *
 * Chrome on Android reads QR codes natively (`BarcodeDetector`); anything
 * without it falls back to jsQR on a downscaled frame. Either way the camera
 * is the rear one, the torch follows the button, and the stream is stopped
 * the moment the scan screen closes — a camera left running on a shared
 * phone drains it by lunchtime.
 *
 * `onState` says whether there is a camera at all, so the screen can offer
 * the design's tap-a-label fallback only where scanning cannot happen.
 * ------------------------------------------------------------------------- */

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type Props = {
  torch: boolean;
  paused: boolean;
  onCode: (code: string) => void;
  onState: (s: "live" | "none" | "denied") => void;
};

export function CameraScanner({ torch, paused, onCode, onState }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const last = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const live = useRef({ paused, onCode, onState });

  useEffect(() => {
    live.current = { paused, onCode, onState };
  }, [paused, onCode, onState]);

  useEffect(() => {
    let stop = false;
    let raf = 0;
    const canvas = document.createElement("canvas");
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    let detector: Detector | null = null;
    let jsqr: ((d: Uint8ClampedArray, w: number, h: number) => { data: string } | null) | null = null;

    const seen = (code: string) => {
      const now = Date.now();
      /* One code, once: a QR held in the frame is read thirty times a second. */
      if (last.current.code === code && now - last.current.at < 2500) return;
      last.current = { code, at: now };
      try {
        navigator.vibrate?.(60);
      } catch {}
      live.current.onCode(code.trim());
    };

    const tick = async () => {
      if (stop) return;
      const v = video.current;
      if (v && v.readyState >= 2 && !live.current.paused) {
        try {
          if (detector) {
            const found = await detector.detect(v);
            if (found[0]?.rawValue) seen(found[0].rawValue);
          } else if (jsqr && ctx2d) {
            const w = 360, h = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * 360) || 360;
            canvas.width = w;
            canvas.height = h;
            ctx2d.drawImage(v, 0, 0, w, h);
            const img = ctx2d.getImageData(0, 0, w, h);
            const r = jsqr(img.data, w, h);
            if (r?.data) seen(r.data);
          }
        } catch {}
      }
      raf = window.setTimeout(() => requestAnimationFrame(() => void tick()), 120) as unknown as number;
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return live.current.onState("none");
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
        if (stop) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => {});
        }
        const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
        if (BD) {
          try {
            detector = new BD({ formats: ["qr_code", "code_128", "ean_13"] });
          } catch {
            detector = null;
          }
        }
        if (!detector) jsqr = (await import("jsqr")).default as unknown as typeof jsqr;
        live.current.onState("live");
        void tick();
      } catch (e) {
        const name = (e as { name?: string })?.name;
        live.current.onState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "none");
      }
    })();

    return () => {
      stop = true;
      clearTimeout(raf);
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, []);

  useEffect(() => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean };
    if (caps.torch) track.applyConstraints({ advanced: [{ torch } as MediaTrackConstraintSet] }).catch(() => {});
  }, [torch]);

  return (
    <video
      ref={video}
      muted
      playsInline
      aria-hidden
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.55, pointerEvents: "none" }}
    />
  );
}

/** A phone photo is several megabytes; the proof needs a readable truck, not a poster. */
export async function shrinkPhoto(file: File, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? file), "image/jpeg", 0.82));
  } catch {
    return file;
  }
}

/* ---------------------------------------------------------------------------
 * A SCANNING GUN IS A KEYBOARD. Paired over Bluetooth it types the label's
 * code and presses Enter, so the scan screen keeps an invisible box focused
 * to catch it — `inputMode="none"` keeps the on-screen keyboard shut, because
 * nobody is typing. A gun set to send no Enter, or a Tab, is caught by the
 * pause after the last character: a gun types a whole code in milliseconds.
 * ------------------------------------------------------------------------- */

export function GunInput({ onCode }: { onCode: (code: string) => void }) {
  const field = useRef<HTMLInputElement>(null);
  const idle = useRef(0);
  const send = useRef(onCode);
  useEffect(() => {
    send.current = onCode;
  }, [onCode]);
  useEffect(() => () => window.clearTimeout(idle.current), []);

  const flush = () => {
    window.clearTimeout(idle.current);
    const el = field.current;
    const code = (el?.value ?? "").trim();
    if (el) el.value = "";
    if (code.length >= 3) send.current(code);
  };
  return (
    <input
      ref={field}
      autoFocus
      inputMode="none"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      tabIndex={-1}
      aria-hidden
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          flush();
        }
      }}
      onInput={() => {
        window.clearTimeout(idle.current);
        idle.current = window.setTimeout(flush, 150);
      }}
      /* A tap elsewhere takes the focus; the gun needs it back. */
      onBlur={() => window.setTimeout(() => field.current?.focus(), 200)}
      style={{ position: "absolute", width: "1px", height: "1px", opacity: 0, left: "-10px", top: "-10px", border: "none", padding: 0 }}
    />
  );
}

const BUZZ = { ok: [70], warn: [70, 90, 70], bad: [450, 120, 450] };

/** A buzz says how the scan went without the loader looking at the phone. */
export function buzz(kind: keyof typeof BUZZ) {
  try {
    navigator.vibrate?.(BUZZ[kind]);
  } catch {}
}

/**
 * The Type box. Its text lives HERE and not in the app's state, so a gun
 * typing a label a letter at a time redraws this box and nothing else. A
 * gun's burst (letters under 80 ms apart) is sent the moment it stops, Enter
 * or not; somebody typing by hand presses Enter or the button. The box
 * empties as it sends, ready for the next label. The phone app's twin is in
 * factory-mobile/src/camera.tsx.
 */
export function ScanField({ onCode, style, label, hint, button }: { onCode: (code: string) => void; style: CSSProperties; label: string; hint: ReactNode; button: (ready: boolean) => { style: CSSProperties; content: ReactNode } }) {
  const [text, setText] = useState("");
  const last = useRef(0);
  const burst = useRef(true);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(idle.current), []);

  const send = (raw: string) => {
    clearTimeout(idle.current);
    const code = raw.trim();
    burst.current = true;
    last.current = 0;
    setText("");
    if (code) onCode(code);
  };
  const b = button(!!text.trim());
  return (
    <>
      <input
        autoFocus
        autoComplete="off"
        aria-label={label}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          const now = Date.now();
          /* One slow letter and it is a person, not a gun: they press Enter. */
          if (!v || (last.current && now - last.current > 80)) burst.current = !v;
          last.current = v ? now : 0;
          const up = v.toUpperCase().slice(0, 60);
          setText(up);
          clearTimeout(idle.current);
          if (burst.current && up.trim().length >= 3) idle.current = setTimeout(() => send(up), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            send(text);
          }
        }}
        style={style}
      />
      {hint}
      <button onClick={() => send(text)} style={b.style}>
        {b.content}
      </button>
    </>
  );
}
