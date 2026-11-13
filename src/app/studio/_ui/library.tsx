"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { archiveDesign, restoreDesign } from "@/lib/actions/studio";
import type { LibraryItem } from "@/lib/studio/library";
import { OccasionChip } from "./parts";

/* ---------------------------------------------------------------------------
 * A template in the shared library: its preview, who uploaded it, the
 * languages it is made in, and — for the person who uploaded it and for whoever
 * approves designs — Archive or Restore. Archiving takes it out of the
 * library for new posters; posters already made from it are unchanged.
 * ------------------------------------------------------------------------- */

export function LibraryTile({ item, canManage, dim = false }: { item: LibraryItem; canManage: boolean; dim?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: (id: string) => ReturnType<typeof archiveDesign>) => {
    setBusy(true);
    const r = await toast.run(action(item.id));
    setBusy(false);
    if (r.ok) router.refresh();
  };
  return (
    <div className="rounded-card border border-line bg-surface" data-testid={`library-${item.id}`}>
      <div className="relative overflow-hidden rounded-t-card border-b border-divider bg-canvas" style={{ aspectRatio: "1 / 1" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored preview, served from our own route */}
        <img src={item.preview} alt={`Preview of ${item.name}`} loading="lazy" className={cx("h-full w-full object-contain", dim ? "opacity-50" : null)} />
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm leading-5 font-semibold text-ink">{item.name}</span>
          {item.archived ? <Badge tone="warn">Archived</Badge> : item.custom ? <Badge tone="brand">Uploaded</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <OccasionChip label={item.occasionLabel} color={item.occasionColor} />
          <span className="text-[12px] text-muted">{item.languages.map((l) => l.label).join(" · ")}</span>
        </div>
        <span className="text-[12px] text-muted">{item.uploaderName ? `By ${item.uploaderName}` : "Built in"}</span>
        {canManage ? (
          <div className="pt-1">
            {!item.archived ? (
              <Link href={`/studio/designs/${item.id}`} className="mr-2 text-[12.5px]" data-testid={`versions-${item.id}`}>
                Versions
              </Link>
            ) : null}
            {item.archived ? (
              <Button size="sm" onClick={() => run(restoreDesign)} disabled={busy} data-testid={`restore-${item.id}`}>
                {busy ? "Restoring…" : "Restore"}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => run(archiveDesign)} disabled={busy} data-testid={`archive-${item.id}`}>
                {busy ? "Archiving…" : "Archive"}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
