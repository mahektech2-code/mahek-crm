"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/* ---------------------------------------------------------------------------
 * A PHOTOGRAPH, FULL SIZE, WITHOUT LEAVING THE CHAT.
 *
 * What customers send is mostly paper — a payment slip, a cheque, a handwritten
 * estimate — photographed at an angle and often on its side, and the figure on
 * it is what the telecaller needs to read. So the viewer turns it (↻ / R),
 * zooms it (wheel, + / −, double-click) and lets it be dragged about once it is
 * bigger than the screen. ← and → step through every photograph in the
 * conversation, so a slip and the cheque sent after it are read side by side
 * rather than opened in two tabs. Esc, the cross or a click on the dark closes.
 *
 * The original is still a click away — Open opens it in a new tab and
 * Download saves it — through the same `/api/whatsapp/media/<id>` route and
 * the same gate as the conversation.
 * ------------------------------------------------------------------------- */

export type ViewerImage = {
  url: string;
  /** What the customer wrote with it, if anything — shown under the photograph. */
  caption: string | null;
  /** "Colour Camp · Today, 1:00 pm" — who sent it and when. */
  meta: string;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const STEP = 1.25;

export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: ViewerImage[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const count = images.length;
  const go = React.useCallback(
    (delta: number) => {
      if (count > 1) onIndex((index + delta + count) % count);
    },
    [count, index, onIndex],
  );

  // Keys belong to the viewer while it is open, and the page behind it does
  // not scroll.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);

  const image = images[index];
  if (!image) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-[#0b0b0c] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Photograph"
    >
      {/* Keyed on the photograph, so zoom, turn and position start fresh for each. */}
      <Stage key={`${index}:${image.url}`} image={image} onClose={onClose} />

      {count > 1 ? (
        <>
          <NavButton side="left" label="Previous photograph (←)" onClick={() => go(-1)} />
          <NavButton side="right" label="Next photograph (→)" onClick={() => go(1)} />
        </>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-6 pt-10 pb-4 text-center">
        {image.caption ? <p className="max-w-[720px] text-sm whitespace-pre-wrap text-white">{image.caption}</p> : null}
        <p className="text-[12px] text-white/70">
          {image.meta}
          {count > 1 ? ` · ${index + 1} of ${count}` : ""}
        </p>
      </div>
    </div>,
    document.body,
  );
}

/** One photograph with its own zoom, turn and position. */
function Stage({ image, onClose }: { image: ViewerImage; onClose: () => void }) {
  const [zoom, setZoom] = React.useState(1);
  const [turn, setTurn] = React.useState(0);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const [failed, setFailed] = React.useState(false);
  const drag = React.useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const setZoomTo = (z: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    setZoom(next);
    // Back at full fit there is nothing to pan, so it re-centres.
    if (next === 1) setOffset({ x: 0, y: 0 });
  };
  const rotate = (by = 90) => {
    setTurn((t) => (t + by + 360) % 360);
    setOffset({ x: 0, y: 0 });
  };
  const reset = () => {
    setZoom(1);
    setTurn(0);
    setOffset({ x: 0, y: 0 });
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r") rotate(90);
      else if (e.key === "R") rotate(-90);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(MAX_ZOOM, z * STEP));
      else if (e.key === "-" || e.key === "_")
        setZoom((z) => {
          const next = Math.max(MIN_ZOOM, z / STEP);
          if (next === 1) setOffset({ x: 0, y: 0 });
          return next;
        });
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // On its side, the photograph has to fit the screen the other way round.
  const sideways = turn % 180 !== 0;
  const fit: React.CSSProperties = sideways
    ? { maxWidth: "calc(100vh - 140px)", maxHeight: "calc(100vw - 160px)" }
    : { maxWidth: "calc(100vw - 160px)", maxHeight: "calc(100vh - 140px)" };

  return (
    <>
      {/* The toolbar */}
      <div className="relative z-10 flex items-center gap-1 border-b border-white/10 bg-[#0b0b0c] px-4 py-3">
        <span className="flex-1" />
        <ToolButton label="Zoom out (−)" onClick={() => setZoomTo(zoom / STEP)} disabled={zoom <= MIN_ZOOM}>
          −
        </ToolButton>
        <span className="w-12 text-center text-[13px] text-white/80 tabular-nums">{Math.round(zoom * 100)}%</span>
        <ToolButton label="Zoom in (+)" onClick={() => setZoomTo(zoom * STEP)} disabled={zoom >= MAX_ZOOM}>
          +
        </ToolButton>
        <ToolButton label="Turn left (Shift+R)" onClick={() => rotate(-90)}>
          ↺
        </ToolButton>
        <ToolButton label="Turn right (R)" onClick={() => rotate(90)}>
          ↻
        </ToolButton>
        <ToolButton label="Back to fit (0)" onClick={reset} disabled={zoom === 1 && turn === 0}>
          Fit
        </ToolButton>
        <span className="mx-2 h-5 w-px bg-white/20" />
        <a
          href={image.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-[4px] px-2.5 py-1.5 text-[13px] text-white no-underline hover:bg-white/10"
        >
          Open original ↗
        </a>
        <a
          href={image.url}
          download
          className="rounded-[4px] px-2.5 py-1.5 text-[13px] text-white no-underline hover:bg-white/10"
        >
          Download
        </a>
        <ToolButton label="Close (Esc)" onClick={onClose}>
          ✕
        </ToolButton>
      </div>

      {/* The photograph. A click on the dark around it closes; on it does not. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onWheel={(e) => setZoomTo(e.deltaY < 0 ? zoom * 1.12 : zoom / 1.12)}
      >
        {failed ? (
          <p className="text-[14px] text-white/80">This photograph could not be loaded — Wati may no longer have it.</p>
        ) : (
          // A customer's file through our own route; next/image would cache a copy.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt={image.caption ?? "Photograph they sent"}
            draggable={false}
            onError={() => setFailed(true)}
            onDoubleClick={() => setZoomTo(zoom > 1 ? 1 : 2.5)}
            onPointerDown={(e) => {
              if (zoom <= 1) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
              setDragging(true);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
            }}
            onPointerUp={() => {
              drag.current = null;
              setDragging(false);
            }}
            style={{
              ...fit,
              transform: `translate(${offset.x}px, ${offset.y}px) rotate(${turn}deg) scale(${zoom})`,
              transition: dragging ? "none" : "transform 120ms ease-out",
              cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
            className="select-none object-contain shadow-2xl"
          />
        )}
      </div>
    </>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="h-8 min-w-8 cursor-pointer rounded-[4px] px-2 text-[15px] text-white hover:bg-white/10 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function NavButton({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`absolute top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-2xl text-white hover:bg-white/20 ${
        side === "left" ? "left-4" : "right-4"
      }`}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}
