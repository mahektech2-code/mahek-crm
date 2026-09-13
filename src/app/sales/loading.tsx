import { ListSkeleton } from "@/components/shell/screen-skeleton";

/**
 * The Manager Console's loading boundary.
 *
 * Production says these screens answer in 40–150 ms, which is fast enough that
 * this skeleton is usually gone before it is read. That is the point: it is
 * not here to entertain somebody through a long wait, it is here so the
 * navigation can COMMIT on the click rather than after the round trip. The URL
 * and the sidebar highlight move immediately, which is the difference between
 * "fast" and "did that register?".
 */
export default function Loading() {
  return <ListSkeleton rows={6} />;
}
