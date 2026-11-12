"use client";

import * as React from "react";
import { cx } from "@/components/ui/primitives";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/file-types";

/* ---------------------------------------------------------------------------
 * The screenshots that go with a report or a reply.
 *
 * Three ways in, because the person reporting a fault is standing on it:
 *
 *   CAPTURE THIS SCREEN — the browser's own screen-share prompt, one frame
 *   taken from it, and the stream closed again. The feedback dialog steps out
 *   of the way while it happens (`fb-capturing` on <body>) so the picture is of
 *   the screen that is wrong, not of the form describing it. Nothing is
 *   installed and nothing runs in the background: no prompt answered, no
 *   picture. Offered only where the browser can do it (desktop Chrome, Edge,
 *   Firefox) — a button that fails when pressed is worse than none.
 *
 *   PASTE — Ctrl+V of a screenshot somebody already took, anywhere in the
 *   form (`usePasteImages`).
 *
 *   PICK — the ordinary file picker, adding rather than replacing.
 *
 * Every way lands in the same list, checked against ACCEPTED_IMAGE_TYPES and
 * the limit here, on the screen, where the person can still do something
 * about it — never silently dropped after Send.
 * ------------------------------------------------------------------------- */

const keyOf = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

export function canCaptureScreen(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function" &&
    !/Android|iPhone|iPad/i.test(navigator.userAgent)
  );
}

/** One frame of the screen the person chooses, as a PNG file. Null when they cancel. */
export async function captureScreen(): Promise<File | null> {
  document.body.classList.add("fb-capturing");
  let stream: MediaStream | null = null;
  try {
    // `preferCurrentTab` puts this tab first in Chrome's picker — it is the
    // screen being reported nine times in ten. Not in the DOM typings yet.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    } as DisplayMediaStreamOptions);
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // The first frame can arrive before the dialog has finished stepping
    // aside; a short wait is the difference between a picture of the screen
    // and a picture of the scrim fading out.
    await new Promise((r) => setTimeout(r, 350));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return null;
    const stampText = new Date().toISOString().slice(11, 19).replace(/:/g, "");
    return new File([blob], `screen-${stampText}.png`, { type: "image/png" });
  } catch {
    return null; // they pressed Cancel, or the browser refused — say nothing
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    document.body.classList.remove("fb-capturing");
  }
}

/** Ctrl+V of a picture anywhere inside `ref` adds it. */
export function usePasteImages(
  ref: React.RefObject<HTMLElement | null>,
  onFiles: (files: File[]) => void,
) {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      onFiles(
        files.map(
          (f, i) =>
            new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}-${i}.png`, {
              type: f.type,
            }),
        ),
      );
    };
    el.addEventListener("paste", handler);
    return () => el.removeEventListener("paste", handler);
  }, [ref, onFiles]);
}

/** Adds to a list under the limit; returns the list and what was refused, in words. */
export function addShots(current: File[], picked: File[], max: number): { files: File[]; refused: string | null } {
  const seen = new Set(current.map(keyOf));
  const wrong = picked.filter((f) => !ACCEPTED_IMAGE_TYPES.includes(f.type));
  const fresh = picked.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type) && !seen.has(keyOf(f)));
  const room = Math.max(0, max - current.length);
  const taken = fresh.slice(0, room);
  const over = fresh.length - taken.length;
  const refused = wrong.length
    ? `${wrong.map((f) => f.name).join(", ")} ${wrong.length === 1 ? "is not" : "are not"} a picture MahekOne can keep — JPG or PNG.`
    : over
      ? `Up to ${max} pictures — ${over} left out.`
      : null;
  return { files: [...current, ...taken], refused };
}

/** The thumbnails already chosen, each with a way to take it off. */
export function ShotThumbs({
  files,
  onRemove,
  size = 72,
}: {
  files: File[];
  onRemove: (index: number) => void;
  size?: number;
}) {
  const previews = React.useMemo(
    () => files.map((f) => ({ key: keyOf(f), url: URL.createObjectURL(f), name: f.name })),
    [files],
  );
  React.useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);
  if (!files.length) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {previews.map((p, i) => (
        <div
          key={p.key}
          className="group relative overflow-hidden rounded-[6px] border border-line bg-canvas"
          style={{ width: size * 1.5, height: size }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, nothing to optimise */}
          <img src={p.url} alt={p.name} className="h-full w-full object-cover" />
          <button
            type="button"
            aria-label={`Remove ${p.name}`}
            onClick={() => onRemove(i)}
            className="absolute top-1 right-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-[rgba(22,22,22,0.7)] text-[12px] leading-none text-white"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** A small square control with an icon, for the picker and capture buttons in a toolbar. */
export function ShotButton({
  onClick,
  label,
  children,
  className,
  disabled,
  wide,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  /** Draw the label beside the icon rather than only as a tooltip. */
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-surface text-[13px] font-medium text-body hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50",
        wide ? "px-3" : "w-9",
        className,
      )}
    >
      {children}
      {wide ? <span>{label}</span> : null}
    </button>
  );
}

/** A hidden file input, opened by `open()`. */
export function useFilePicker(onFiles: (files: File[]) => void) {
  const ref = React.useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept={ACCEPTED_IMAGE_TYPES.join(",")}
      multiple
      className="hidden"
      onChange={(e) => {
        onFiles([...(e.target.files ?? [])]);
        e.target.value = "";
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}

export const ScreenIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export const PictureIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);
