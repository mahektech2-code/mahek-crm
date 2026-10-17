"use client";

import { Badge } from "@/components/ui/primitives";
import type { Result } from "@/lib/result";
import type { ItemView, PublishOutcome } from "@/lib/website-cms/service";

/* ---------------------------------------------------------------------------
 * SAYING WHAT HAPPENED — and never more than that.
 *
 * Every toast on the Website screens comes through here. The rule it keeps: a
 * result that is not a clean success is not drawn as one. A publish that
 * committed in MahekOne but whose refresh of the live site failed is an ERROR
 * toast, because from the visitor's side nothing has changed yet; the same
 * publish when the site is not connected is a WARNING-worded notice. Only a
 * refresh the live site confirmed is drawn as success.
 * ------------------------------------------------------------------------- */

type Toast = { push: (message: string, tone?: "info" | "error") => void };

export function reportResult<T>(toast: Toast, r: Result<T>): boolean {
  if (!r.ok) {
    toast.push(r.error, "error");
    return false;
  }
  if (r.message) toast.push(r.message);
  return true;
}

/** For publish, unpublish, archive and refresh: the live site's own answer decides the tone. */
export function reportPublish(toast: Toast, r: Result<PublishOutcome | { live: PublishOutcome["live"] }>): boolean {
  if (!r.ok) {
    toast.push(r.error, "error");
    return false;
  }
  const live = r.data.live;
  const degraded = live !== null && live !== undefined && live.status !== "refreshed";
  const notes = r.warnings?.length ? ` ${r.warnings.join(" ")}` : "";
  toast.push(`${r.message ?? "Done."}${notes}`, degraded ? "error" : "info");
  return true;
}

export function StateBadge({ item }: { item: Pick<ItemView, "state" | "hasChanges" | "everPublished"> }) {
  if (item.state === "archived") return <Badge tone="muted">Archived</Badge>;
  if (item.state === "published") {
    return item.hasChanges ? <Badge tone="warn">Live · unpublished changes</Badge> : <Badge tone="success">Live</Badge>;
  }
  return item.everPublished ? <Badge tone="muted">Taken down</Badge> : <Badge tone="neutral">Draft</Badge>;
}
