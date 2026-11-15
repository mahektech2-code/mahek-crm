"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useWorkday } from "./workday-context";
import { safeNext } from "@/lib/workday-lock-paths";

/**
 * Where somebody was going when the workday lock sent them to the launcher.
 * `requireUser` redirects a locked page to `/apps?next=<address>`; once the
 * day reads unlocked (they punched in, or resumed from a break) this takes
 * them on to that address. Only a path on this site is followed.
 */
export function ResumeAfterUnlock({ next }: { next: string | null }) {
  const w = useWorkday();
  const router = useRouter();
  const done = React.useRef(false);
  const target = safeNext(next);
  const unlocked = !!w && !w.state.locked;
  React.useEffect(() => {
    if (!target || !unlocked || done.current) return;
    done.current = true;
    router.replace(target);
  }, [target, unlocked, router]);
  return null;
}
