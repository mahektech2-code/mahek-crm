"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * 1–9 opens the app in that position on the launcher, in the same order the
 * cards are drawn — the badge on each card is the key that opens it. Only
 * bound when there is more than one app, because a single card is not a choice
 * and the hint is hidden in that case too.
 */
export function AppShortcuts({ hrefs }: { hrefs: string[] }) {
  const router = useRouter();

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (!/^[1-9]$/.test(e.key)) return;

      const href = hrefs[Number(e.key) - 1];
      if (!href) return;
      e.preventDefault();
      router.push(href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hrefs, router]);

  return null;
}
