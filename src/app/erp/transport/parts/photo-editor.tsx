"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/primitives";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { IconButton } from "../../_ui/look";
import { Icon } from "../../_ui/icons";
import { erpLogisticsReplaceFile } from "@/lib/actions/erp-logistics";
import { useAct } from "./common";

/* ---------------------------------------------------------------------------
 * CROP AND ROTATE A COPY, on the laptop, before anybody reads it again. The
 * photo is drawn on a canvas, turned a quarter at a time, and cut to the box
 * dragged by its corners; Save uploads the result as a new photo and puts it
 * on the copy (`replaceLrFile`). Nothing is cut until Save, and the original
 * stays in the record. A PDF has no pixels to cut, so it is not offered.
 * ------------------------------------------------------------------------- */

type Box = { x: number; y: number; w: number; h: number };
type Drag = { mode: "move" | "tl" | "tr" | "bl" | "br"; x: number; y: number; start: Box };
const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
const MIN = 0.08;
const VIEW_W = 640;
const VIEW_H = 460;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The photo turned by `turns` quarters, drawn whole onto a canvas. */
function rotated(img: HTMLImageElement, turns: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const side = turns % 2 === 1;
  c.width = side ? img.naturalHeight : img.naturalWidth;
  c.height = side ? img.naturalWidth : img.naturalHeight;
  const g = c.getContext("2d")!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((turns * Math.PI) / 2);
  g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return c;
}

export function PhotoEditor({ lrId, fileId, onClose }: { lrId: string; fileId: string; onClose: () => void }) {
  const { run, pending } = useAct();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [broken, setBroken] = useState(false);
  const [turns, setTurns] = useState(0);
  const [box, setBox] = useState<Box>(FULL);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const view = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setBroken(true);
    i.src = `/api/attachments/${fileId}`;
  }, [fileId]);

  /* The shown size: the turned photo fitted into the view, never enlarged. */
  const turned = img ? (turns % 2 === 1 ? { w: img.naturalHeight, h: img.naturalWidth } : { w: img.naturalWidth, h: img.naturalHeight }) : { w: 4, h: 3 };
  const scale = Math.min(VIEW_W / turned.w, VIEW_H / turned.h, 1);
  const shown = { w: Math.round(turned.w * scale), h: Math.round(turned.h * scale) };

  useEffect(() => {
    if (!img || !view.current) return;
    const c = view.current;
    c.width = shown.w;
    c.height = shown.h;
    c.getContext("2d")!.drawImage(rotated(img, turns), 0, 0, shown.w, shown.h);
  }, [img, turns, shown.w, shown.h]);

  const turn = (by: number) => {
    setTurns((t) => (t + by + 4) % 4);
    setBox(FULL);
  };

  const onDown = (mode: Drag["mode"]) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ mode, x: e.clientX, y: e.clientY, start: box });
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag;
    if (!d) return;
    const dx = (e.clientX - d.x) / shown.w;
    const dy = (e.clientY - d.y) / shown.h;
    const s = d.start;
    let n: Box;
    if (d.mode === "move") n = { ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) };
    else {
      let { x, y, w, h } = s;
      if (d.mode === "tl" || d.mode === "bl") {
        const nx = clamp(s.x + dx, 0, s.x + s.w - MIN);
        w = s.w + (s.x - nx);
        x = nx;
      } else w = clamp(s.w + dx, MIN, 1 - s.x);
      if (d.mode === "tl" || d.mode === "tr") {
        const ny = clamp(s.y + dy, 0, s.y + s.h - MIN);
        h = s.h + (s.y - ny);
        y = ny;
      } else h = clamp(s.h + dy, MIN, 1 - s.y);
      n = { x, y, w, h };
    }
    setBox(n);
  };
  const onUp = () => setDrag(null);

  const save = async () => {
    if (!img) return;
    setSaving(true);
    setError("");
    try {
      const full = rotated(img, turns);
      const cut = document.createElement("canvas");
      cut.width = Math.max(1, Math.round(box.w * full.width));
      cut.height = Math.max(1, Math.round(box.h * full.height));
      cut.getContext("2d")!.drawImage(full, Math.round(box.x * full.width), Math.round(box.y * full.height), cut.width, cut.height, 0, 0, cut.width, cut.height);
      const blob = await new Promise<Blob | null>((ok) => cut.toBlob(ok, "image/jpeg", 0.9));
      if (!blob) throw new Error("The photo could not be saved");
      const body = new FormData();
      body.set("file", new File([blob], "copy.jpg", { type: "image/jpeg" }));
      body.set("kind", "photo");
      const res = await fetch("/api/erp/attachments", { method: "POST", body });
      const j = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !j.id) throw new Error(j.error || "Upload failed");
      const id = j.id;
      run(() => erpLogisticsReplaceFile(lrId, id), (r) => r.ok && onClose());
    } catch (e) {
      setError(e instanceof Error ? e.message : "The photo could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const untouched = turns === 0 && box.x === 0 && box.y === 0 && box.w === 1 && box.h === 1;
  const handle = "absolute h-3.5 w-3.5 rounded-full border-2 border-brand bg-surface";

  return (
    <ErpDialog onClose={onClose} label="Crop photo" width={720} tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>Crop photo</DialogTitle>
      </DialogHeader>
      <DialogBody className="items-center gap-3">
        {broken ? (
          <p className="py-10 text-sm text-muted">A PDF cannot be cropped.</p>
        ) : !img ? (
          <p className="py-10 text-sm text-muted">Loading…</p>
        ) : (
          <div className="relative touch-none select-none" style={{ width: shown.w, height: shown.h }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            <canvas ref={view} className="block rounded-control" />
            {/* Everything outside the box is dimmed; the box itself is dragged to move it. */}
            <div
              onPointerDown={onDown("move")}
              className="absolute cursor-move border-2 border-brand"
              style={{ left: box.x * shown.w, top: box.y * shown.h, width: box.w * shown.w, height: box.h * shown.h, boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)" }}
            >
              <span onPointerDown={onDown("tl")} className={`${handle} -top-2 -left-2 cursor-nwse-resize`} />
              <span onPointerDown={onDown("tr")} className={`${handle} -top-2 -right-2 cursor-nesw-resize`} />
              <span onPointerDown={onDown("bl")} className={`${handle} -bottom-2 -left-2 cursor-nesw-resize`} />
              <span onPointerDown={onDown("br")} className={`${handle} -right-2 -bottom-2 cursor-nwse-resize`} />
            </div>
          </div>
        )}
        {error ? <p className="text-meta text-danger">{error}</p> : null}
      </DialogBody>
      <DialogFooter
        left={
          <div className="flex gap-1">
            <IconButton label="Rotate left" disabled={!img} onClick={() => turn(-1)}>
              <Icon n="rotate" />
            </IconButton>
            <IconButton label="Rotate right" disabled={!img} onClick={() => turn(1)}>
              <span className="-scale-x-100">
                <Icon n="rotate" />
              </span>
            </IconButton>
            <IconButton label="Reset" disabled={!img || untouched} onClick={() => (setBox(FULL), setTurns(0))}>
              <Icon n="refresh" />
            </IconButton>
          </div>
        }
      >
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!img || untouched || saving || pending} onClick={() => void save()}>
          {saving || pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
