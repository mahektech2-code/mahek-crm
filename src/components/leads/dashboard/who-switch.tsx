"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { setScope } from "@/lib/actions/crm";

/**
 * Mine / Team on My day. It is the header's own scope switch — the same
 * preference, the same action — drawn where the queue it narrows is. The
 * action refuses an associate, so this is drawn only for a manager here.
 */
export function WhoSwitch({ who }: { who: "mine" | "team" }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <div
      role="group"
      aria-label="Whose work"
      className="inline-flex rounded-[8px] border border-line bg-surface p-[3px]"
    >
      {(["mine", "team"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={who === s}
          disabled={pending}
          onClick={() =>
            start(async () => {
              await setScope(s);
              router.refresh();
            })
          }
          className={cx(
            "h-[30px] cursor-pointer rounded-[6px] px-3.5 text-[13px] font-medium disabled:cursor-wait",
            who === s ? "bg-ink text-white" : "text-body hover:text-ink",
          )}
        >
          {s === "mine" ? "Mine" : "Team"}
        </button>
      ))}
    </div>
  );
}
