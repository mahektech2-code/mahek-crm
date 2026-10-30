"use client";

import { useRef, useState } from "react";
import { Button, cx } from "@/components/ui/primitives";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { IconButton, toggleClass } from "../../_ui/look";
import { Icon } from "../../_ui/icons";
import { erpLogisticsUploadLrs } from "@/lib/actions/erp-logistics";
import { UPLOAD_MAX } from "@/lib/erp/engines/delivery-proof";
import type { ProofKind } from "@/lib/erp/engines/logistics";
import type { RecentLr } from "@/lib/erp/logistics";
import { shrinkImage } from "@/lib/shrink-image";
import { useAct } from "./common";

/* ---------------------------------------------------------------------------
 * UPLOAD, on a laptop: pick up to ten photos or PDFs of LRs or customer-signed
 * copies, and send them. Nothing is typed here — the Documents desk reads
 * each one, flags duplicates and is where it is checked and attached. Each
 * file goes up the moment it is picked, so Send only files what is already in.
 * The same photo sent twice is stored once, and the dialog then names the copy
 * it already is, so nobody reads "nothing new" as a failure and sends it again.
 * ------------------------------------------------------------------------- */

type Tile = { key: string; name: string; preview: string | null; fileId: string | null; state: "up" | "done" | "failed"; error: string; file: File };
let seq = 0;

export function UploadLrsButton({
  variant = "primary",
  initialOpen = false,
}: {
  today?: string;
  transporters?: string[];
  recent?: RecentLr[];
  canRead?: boolean;
  variant?: "primary" | "secondary";
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  /* Opened by an old /erp/transport/upload link: drop ?upload=1 on close, or a reload opens it again. */
  const close = () => {
    setOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.has("upload")) {
      url.searchParams.delete("upload");
      window.history.replaceState(null, "", url);
    }
  };
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Icon n="upload" s={15} />
        Upload
      </Button>
      {open ? <UploadDialog onClose={close} /> : null}
    </>
  );
}

function UploadDialog({ onClose }: { onClose: () => void }) {
  const { run, pending } = useAct();
  const [kind, setKind] = useState<ProofKind>("lr");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState("");
  /* Photos the desk already had, by file name, with where that copy went. Kept until the next upload. */
  const [repeats, setRepeats] = useState<{ name: string; what: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const patch = (key: string, p: Partial<Tile>) => setTiles((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t)));
  const send = async (t: Tile) => {
    patch(t.key, { state: "up", error: "" });
    try {
      const body = new FormData();
      body.set("file", await shrinkImage(t.file));
      body.set("kind", "photo");
      const res = await fetch("/api/erp/attachments", { method: "POST", body });
      const j = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !j.id) throw new Error(j.error || "Upload failed");
      patch(t.key, { fileId: j.id, state: "done" });
    } catch (e) {
      patch(t.key, { state: "failed", error: e instanceof Error ? e.message : "Upload failed" });
    }
  };
  const add = (files: FileList | null) => {
    if (!files?.length) return;
    setRepeats([]);
    const room = UPLOAD_MAX - tiles.length;
    const picked = [...files].slice(0, Math.max(0, room));
    setNote(files.length > room ? `Only ${UPLOAD_MAX} fit in one upload. Send these, then add the rest.` : "");
    const fresh = picked.map((file) => ({ key: `u${++seq}`, name: file.name, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null, fileId: null, state: "up" as const, error: "", file }));
    setTiles((ts) => [...ts, ...fresh]);
    /* Three at a time: quick on office Wi-Fi, and never ten requests at once on a weak link. */
    void (async () => {
      for (let i = 0; i < fresh.length; i += 3) await Promise.all(fresh.slice(i, i + 3).map(send));
    })();
  };
  const done = tiles.filter((t) => t.fileId);
  const busy = tiles.some((t) => t.state === "up");
  const word = kind === "lr" ? (done.length === 1 ? "LR" : "LRs") : done.length === 1 ? "signed copy" : "signed copies";

  const submit = () =>
    run(
      () => erpLogisticsUploadLrs(done.map((t) => ({ fileId: t.fileId, kind }))),
      (r) => {
        if (r.ok) {
          const nameOf = new Map(done.map((t) => [t.fileId, t.name]));
          setRepeats(r.data.repeats.map((x) => ({ name: nameOf.get(x.fileId) ?? "A photo", what: x.what })));
          setTiles((ts) => ts.filter((t) => !t.fileId));
          setNote("");
        }
      },
    );

  return (
    <ErpDialog onClose={onClose} label="Upload" width={620} tall={false}>
      <DialogHeader
        onClose={onClose}
        aside={
          <div className="flex gap-1 rounded-control bg-canvas p-1">
            {(["lr", "signed_copy"] as ProofKind[]).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} className={toggleClass(kind === k)}>
                {k === "lr" ? "LR" : "Signed copy"}
              </button>
            ))}
          </div>
        }
      >
        <DialogTitle>Upload</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <input ref={input} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={(e) => (add(e.target.files), (e.target.value = ""))} />
        {tiles.length ? (
          <>
            <div className="text-meta text-muted">
              {tiles.length} of {UPLOAD_MAX} · {done.length} in
            </div>
            <div className="grid grid-cols-5 gap-2">
              {tiles.map((t) => (
                <div key={t.key} className={cx("relative aspect-[3/4] overflow-hidden rounded-control border bg-canvas", t.state === "failed" ? "border-danger" : "border-line")} title={t.error || t.name}>
                  {t.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.preview} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center text-2xs font-semibold text-muted">PDF</span>
                  )}
                  {t.state === "up" ? <span className="absolute inset-x-1.5 bottom-1.5 h-1 animate-pulse rounded-full bg-brand" aria-label="Uploading" /> : null}
                  {t.state === "done" ? (
                    <span className="absolute right-1 bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-success text-white" aria-label="Uploaded">
                      <Icon n="check" s={12} />
                    </span>
                  ) : null}
                  {t.state === "failed" ? (
                    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-surface/80">
                      <IconButton label="Try again" onClick={() => void send(t)}>
                        <Icon n="refresh" />
                      </IconButton>
                    </span>
                  ) : null}
                  {t.state !== "up" ? (
                    <IconButton label="Remove" className="absolute top-0.5 right-0.5 h-6 w-6 bg-surface/90" onClick={() => setTiles((ts) => ts.filter((x) => x.key !== t.key))}>
                      <Icon n="x" s={12} />
                    </IconButton>
                  ) : null}
                </div>
              ))}
              {tiles.length < UPLOAD_MAX ? (
                <button type="button" onClick={() => input.current?.click()} className="flex aspect-[3/4] cursor-pointer flex-col items-center justify-center gap-1 rounded-control border border-dashed border-line-strong text-meta text-muted hover:bg-canvas" aria-label="Add more">
                  <Icon n="plus" s={20} />
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <div
            onDragOver={(e) => (e.preventDefault(), setDrag(true))}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => (e.preventDefault(), setDrag(false), add(e.dataTransfer.files))}
            className={cx("flex h-64 flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed text-muted", drag ? "border-brand bg-brand-soft" : "border-line")}
          >
            <span className="text-brand">
              <Icon n="upload" s={32} />
            </span>
            <span className="text-sm font-semibold text-ink">Drop photos or PDFs</span>
            <Button onClick={() => input.current?.click()}>
              <Icon n="plus" s={14} />
              Choose files
            </Button>
            <span className="text-meta">Up to {UPLOAD_MAX}</span>
          </div>
        )}
        {note ? <p className="text-meta text-warn-ink">{note}</p> : null}
        {repeats.length ? (
          <div className="flex flex-col gap-1 rounded-control border border-line bg-canvas p-3 text-meta" role="status">
            <span className="font-semibold text-ink">Not sent again — the desk already has {repeats.length === 1 ? "this photo" : "these photos"}</span>
            {repeats.map((x, i) => (
              <span key={i} className="text-muted">
                <span className="text-ink">{x.name}</span> — {x.what}
              </span>
            ))}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={pending || busy || !done.length} title={busy ? "Wait for every file to go up" : undefined} onClick={submit}>
          {done.length ? `Send ${done.length} ${word}` : "Send"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
