import { ListSkeleton } from "@/components/shell/screen-skeleton";

/**
 * The same boundary the CRM and the Manager Console have, for the same reason:
 * without one, a dynamic route gives Next nothing to show, so the browser
 * holds the previous page until the whole payload lands. See
 * `src/app/crm/loading.tsx`.
 */
export default function Loading() {
  return <ListSkeleton rows={6} />;
}
