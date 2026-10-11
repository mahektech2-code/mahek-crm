"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Badge, Button } from "@/components/ui/primitives";
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
  variant = "primary",
  initialOpen = false,
}: {
  today: string;
  transporters: string[];
  recent: RecentLr[];
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
      <Modal open={open} onClose={close} title="Upload LRs" width={900}>
        <p className="mb-3 text-[13px] text-muted">Photograph each lorry receipt collected from the transporters and type its number. Logistics attaches them to the bills and the customer is told.</p>
        <LrUpload today={today} transporters={transporters} />
        <h3 className="mt-6 mb-2 text-[13px] font-semibold text-ink">Uploaded lately</h3>
        <div className="max-h-[260px] overflow-y-auto rounded-[4px] border border-line">
          {recent.length ? (
            recent.map((l) => (
              <div key={l.id} className="flex items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-0">
                <LrThumb fileId={l.fileId} size={32} />
                <span className={l.lrNo ? "w-[150px] truncate font-mono font-medium" : "w-[150px] truncate text-muted"}>{lrUploadName(l.lrNo)}</span>
                <span className="min-w-0 flex-1 truncate text-body">{[l.transporter, l.destination].filter(Boolean).join(" · ") || "—"}</span>
                <span className="w-[70px] text-[13px] text-muted">{l.lrDate ? shortDay(l.lrDate) : "—"}</span>
                <span className="w-[120px] truncate text-[12px] text-muted">by {l.uploadedBy ?? "—"}</span>
                {l.status === "assigned" ? <Badge tone="success">Attached to {l.bills} bill{l.bills === 1 ? "" : "s"}</Badge> : <Badge tone="warn">Waiting for logistics</Badge>}
              </div>
            ))
          ) : (
            <div className="px-4 py-5 text-center text-sm text-muted">Nothing uploaded yet.</div>
          )}
        </div>
      </Modal>
    </>
  );
}
