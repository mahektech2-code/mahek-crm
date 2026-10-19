"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { SubTitle } from "../../_ui/look";
import { lrUploadName, shortDay } from "@/lib/erp/engines/logistics";
import type { RecentLr } from "@/lib/erp/logistics";
import { LrThumb } from "./common";
import { LrUpload } from "./lr-upload";

/**
 * Upload LRs, as a modal over whichever desk it was opened from — the
 * Logistics screen or the Dispatch desk. It used to be a page of its own, so
 * uploading the LRs for one lorry meant leaving the desk and finding the way
 * back. Below the form, what was uploaded lately and whether logistics has
 * attached it, because the dispatch team cannot open the LR desk to check.
 */
export function UploadLrsButton({
  today,
  transporters,
  recent,
  canRead = false,
  variant = "primary",
  initialOpen = false,
}: {
  today: string;
  transporters: string[];
  recent: RecentLr[];
  /** Whether a photo is read into its row (OpenAI, `erp.ai.photos`). */
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
        Upload LRs
      </Button>
      {open ? (
        <ErpDialog onClose={close} label="Upload LRs" width={900} tall={false}>
          <DialogHeader onClose={close}>
            <DialogTitle>Upload LRs</DialogTitle>
          </DialogHeader>
          <DialogBody>
        <p className="text-meta text-muted">
          {canRead
            ? "Photograph each lorry receipt collected from the transporters. Its number, date, transporter and the rest are read off the photo — check them before uploading. Logistics attaches them to the bills and the customer is told."
            : "Photograph each lorry receipt collected from the transporters and type its number. Logistics attaches them to the bills and the customer is told."}
        </p>
        <LrUpload today={today} transporters={transporters} canRead={canRead} />
        <section>
        <SubTitle>Uploaded lately</SubTitle>
        <div className="max-h-[260px] overflow-y-auto rounded-card border border-line">
          {recent.length ? (
            recent.map((l) => (
              <div key={l.id} className="flex items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-0">
                <LrThumb fileId={l.fileId} size={32} />
                <span className={l.lrNo ? "w-[150px] truncate font-mono font-medium" : "w-[150px] truncate text-muted"}>{lrUploadName(l.lrNo)}</span>
                <span className="min-w-0 flex-1 truncate text-body">{[l.transporter, l.destination].filter(Boolean).join(" · ") || "—"}</span>
                <span className="w-[70px] text-meta text-muted">{l.lrDate ? shortDay(l.lrDate) : "—"}</span>
                <span className="w-[120px] truncate text-xs text-muted">by {l.uploadedBy ?? "—"}</span>
                {l.status === "assigned" ? <Badge label={`Attached to ${l.bills} bill${l.bills === 1 ? "" : "s"}`} tone="success" /> : <Badge label="Waiting for logistics" tone="warn" />}
              </div>
            ))
          ) : (
            <div className="px-3 py-4 text-center text-meta text-muted">Nothing uploaded yet.</div>
          )}
        </div>
        </section>
          </DialogBody>
        </ErpDialog>
      ) : null}
    </>
  );
}
