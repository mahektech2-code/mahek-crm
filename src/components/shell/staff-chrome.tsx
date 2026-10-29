"use client";

import { usePathname } from "next/navigation";
import { isPublicPath } from "@/lib/public-links";
import { NotificationCenter } from "./notification-center";
import { VersionGuard } from "./version-guard";

/**
 * The staff app's furniture on every page — the live bell and the stale-tab
 * guard — and on no page a customer or a vendor is sent. Neither mounts there
 * at all: no poll for a session that page has never had, no update banner on a
 * link somebody forwarded.
 */
export function StaffChrome() {
  const pathname = usePathname();
  if (isPublicPath(pathname)) return null;
  return (
    <>
      {/* The live bell: polls, pops and chimes in every app. */}
      <NotificationCenter />
      {/* A tab older than the server: reload it before a save is refused. */}
      <VersionGuard />
    </>
  );
}
