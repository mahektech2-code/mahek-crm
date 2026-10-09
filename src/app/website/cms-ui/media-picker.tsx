"use client";

import * as React from "react";
import { Button, Input } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { WEBSITE_IMAGE_MAX_BYTES } from "@/lib/website-cms/media-types";
import type { MediaView } from "@/lib/website-cms/media-service";
import { thumbUrl, useCmsEnv } from "./cms-env";

/* ---------------------------------------------------------------------------
 * CHOOSING AN IMAGE — from the library, or by uploading one.
 *
 * An upload goes to `/api/website/media`, which judges the file by its bytes and
 * answers with the library entry; this component only ever shows what the
 * server said. Nothing here pretends a file was stored: a refusal is shown as
 * the server worded it.
 * ------------------------------------------------------------------------- */

export function MediaThumb({ url, className = "h-14 w-14" }: { url: string; className?: string }) {
  // Keyed on the address, so a new picture starts fresh instead of inheriting "broken".
  return <ThumbBox key={url} url={url} className={className} />;
}

function ThumbBox({ url, className }: { url: string; className: string }) {
  const { siteUrl } = useCmsEnv();
  const [broken, setBroken] = React.useState(false);
  return (
    <div className={`flex flex-none items-center justify-center overflow-hidden rounded-[4px] border border-line bg-canvas ${className}`}>
      {url && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl(url, siteUrl)} alt="" className="h-full w-full object-contain" onError={() => setBroken(true)} />
      ) : (
        <span className="px-1 text-center text-[10px] text-muted">{url ? "Not found" : "No image"}</span>
      )}
    </div>
  );
}

/** Uploads one file; resolves to the library entry or a message. */
export async function uploadImage(file: File, alt = ""): Promise<{ ok: true; media: MediaView; message?: string } | { ok: false; error: string }> {
  if (file.size > WEBSITE_IMAGE_MAX_BYTES) {
    return { ok: false, error: `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${WEBSITE_IMAGE_MAX_BYTES / (1024 * 1024)} MB.` };
  }
  const form = new FormData();
  form.set("file", file);
  form.set("alt", alt);
  try {
    const res = await fetch("/api/website/media", { method: "POST", body: form });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; media?: MediaView; error?: string; message?: string } | null;
    if (res.ok && body?.ok && body.media) return { ok: true, media: body.media, message: body.message };
    return { ok: false, error: body?.error ?? `The upload failed (${res.status}).` };
  } catch {
    return { ok: false, error: "The upload could not reach the server. Nothing was added." };
  }
}

export function MediaPicker({ onPick, onClose }: { onPick: (url: string) => void; onClose: () => void }) {
  const { media, addMedia } = useCmsEnv();
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const needle = q.trim().toLowerCase();
  const shown = media.filter((m) => !needle || m.filename.toLowerCase().includes(needle) || m.alt.toLowerCase().includes(needle) || m.url.toLowerCase().includes(needle));
  const uploads = shown.filter((m) => m.source === "upload");
  const site = shown.filter((m) => m.source === "site");

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await uploadImage(file);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    addMedia(r.media);
    setNotice(r.message ?? "Image added.");
    onPick(r.media.url);
  }

  const tile = (m: MediaView) => (
    <button
      key={m.id}
      type="button"
      onClick={() => onPick(m.url)}
      className="flex w-[116px] cursor-pointer flex-col gap-1 rounded-[4px] border border-line bg-surface p-1.5 text-left hover:border-brand"
      title={m.url}
    >
      <MediaThumb url={m.url} className="h-[92px] w-full" />
      <span className="truncate text-[11px] text-body">{m.filename}</span>
    </button>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Choose an image"
      width={760}
      footer={
        <>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={onFile} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Uploading…" : "Upload a new image"}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input placeholder="Search by file name" value={q} onChange={(e) => setQ(e.target.value)} />
        {error ? <div className="rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div> : null}
        {notice ? <div className="rounded-[4px] bg-brand-soft px-3 py-2 text-sm text-body">{notice}</div> : null}
        <div className="max-h-[52vh] overflow-y-auto">
          <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Uploaded here ({uploads.length})</div>
          {uploads.length === 0 ? (
            <p className="mb-3 text-sm text-muted">Nothing uploaded yet. JPG, PNG, WebP or GIF up to {WEBSITE_IMAGE_MAX_BYTES / (1024 * 1024)} MB.</p>
          ) : (
            <div className="mb-4 flex flex-wrap gap-2">{uploads.map(tile)}</div>
          )}
          <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Already on the website ({site.length})</div>
          {site.length === 0 ? <p className="text-sm text-muted">No site files listed. Import the website&apos;s content from the Dashboard.</p> : <div className="flex flex-wrap gap-2">{site.map(tile)}</div>}
        </div>
      </div>
    </Modal>
  );
}
