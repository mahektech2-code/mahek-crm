import { ListSkeleton } from "@/components/shell/screen-skeleton";

/**
 * Every ERP screen's boundary. Without one a dynamic route gives Next nothing
 * to show, so a click on the sidebar held the previous screen until the whole
 * of the next one had been read — on the real book that read as the ERP not
 * having heard the click. With it the sidebar link is prefetched down to
 * here, the skeleton is drawn the instant it is pressed, and the rows follow.
 * See `src/app/crm/loading.tsx`.
 */
export default function Loading() {
  return <ListSkeleton rows={8} />;
}
