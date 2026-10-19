"use client";

import { useState } from "react";
import { Card } from "@/components/ui/primitives";
import { Eyebrow, LinkButton, linkClass } from "../../_ui/look";

/** The customer's tracking link, to copy into a chat that is not on WhatsApp. */
export function TrackLinkCopy({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  return (
    <Card className="p-4">
      <Eyebrow>Customer&apos;s tracking link</Eyebrow>
      <div className="mt-1 flex items-center gap-2">
        <a href={`/track/${token}`} target="_blank" rel="noreferrer" className={linkClass("brand", "min-w-0 flex-1 truncate font-mono text-xs")}>
          /track/{token}
        </a>
        <LinkButton
          className="text-xs"
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
        </LinkButton>
      </div>
      <div className="mt-1 text-meta text-muted">Every WhatsApp to the customer carries it. It shows where the goods are, never prices or call notes.</div>
    </Card>
  );
}
