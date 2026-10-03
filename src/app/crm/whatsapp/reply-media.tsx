"use client";

import * as React from "react";
import { MEDIA_LABEL, type MediaType } from "@/lib/whatsapp-delivery";

/* ---------------------------------------------------------------------------
 * What a customer sent when it was not words, drawn where they sent it.
 *
 * It used to be the word "[image]" in a bubble, and the photograph of the
 * payment slip — the thing the whole message was about — could only be seen by
 * opening Wati. A photograph draws here, a PDF previews here, a voice note and
 * a video play here; each opens full size in a new tab.
 *
 * The file is read through `/api/whatsapp/media/<id>`, behind the same gate as
 * the conversation, and a file Wati can no longer give us says so rather than
 * drawing a broken image.
 * ------------------------------------------------------------------------- */

export function ReplyMedia({
  type,
  url,
  pdf,
  caption,
}: {
  type: string;
  url: string;
  /** Only a PDF is previewed: anything else the route hands over as a download, and previewing that would download it. */
  pdf: boolean;
  caption: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const label = MEDIA_LABEL[type as MediaType] ?? "File";

  if (failed) {
    return (
      <div className="rounded-[4px] border border-dashed border-line-strong bg-canvas px-3 py-2 text-[13px] text-muted">
        {label} — Wati could not give it back. It may have expired there.
      </div>
    );
  }

  if (type === "image" || type === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer" title="Open full size" className="block">
        {/* A customer's file, served by our own route; next/image would cache a copy. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={caption && caption !== label ? caption : `${label} they sent`}
          loading="lazy"
          onError={() => setFailed(true)}
          className={type === "sticker" ? "h-32 w-32 object-contain" : "max-h-72 max-w-full rounded-[4px] object-contain"}
        />
      </a>
    );
  }

  if (type === "audio") {
    return <audio controls preload="none" src={url} onError={() => setFailed(true)} className="w-64 max-w-full" />;
  }

  if (type === "video") {
    return (
      <video controls preload="metadata" src={url} onError={() => setFailed(true)} className="max-h-72 max-w-full rounded-[4px]" />
    );
  }

  // A document. A PDF previews in the browser's own viewer; anything else is a
  // file to save, which the route hands over rather than draws.
  return (
    <div className="w-[320px] max-w-full overflow-hidden rounded-[4px] border border-line bg-surface">
      {pdf ? (
        <object data={url} type="application/pdf" className="block h-[240px] w-full bg-canvas" aria-label="Document they sent">
          <div className="flex h-[240px] items-center justify-center px-4 text-center text-[13px] text-muted">
            This browser cannot preview the PDF. Open it to read it.
          </div>
        </object>
      ) : null}
      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
        <span className="truncate text-[13px] font-medium text-ink">{caption && caption !== label ? caption : label}</span>
        <a href={url} target="_blank" rel="noreferrer" className="flex-none text-[13px] font-medium">
          {pdf ? "Open" : "Download"}
        </a>
      </div>
    </div>
  );
}
