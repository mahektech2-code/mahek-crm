"use client";

import { useEffect, useRef } from "react";

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
