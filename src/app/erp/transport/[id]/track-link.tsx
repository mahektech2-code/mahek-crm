"use client";

import { useState } from "react";
import { Card } from "@/components/ui/primitives";

/** The customer's tracking link, to copy into a chat that is not on WhatsApp. */
export function TrackLinkCopy({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Customer&apos;s tracking link</div>
      <div className="mt-1 flex items-center gap-2">
        <a href={`/track/${token}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[12px]">
          /track/{token}
        </a>
        <button
          className="cursor-pointer text-[12px] font-medium text-brand"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(`${window.location.origin}/track/${token}`);
              setDone(true);
            } catch {
              setDone(false);
            }
          }}
        >
          {done ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="mt-1 text-[12px] text-muted">Every WhatsApp to the customer carries it. It shows where the goods are, never prices or call notes.</div>
    </Card>
  );
}
