import { ListSkeleton } from "@/components/shell/screen-skeleton";

/**
 * This app's loading boundary. Without one a dynamic route gives Next nothing
 * to show, so a click held the previous screen until the whole of the next
 * had been read — which reads as the click not having been heard. See
 * `src/app/crm/loading.tsx`.
 */
export default function Loading() {
  return <ListSkeleton />;
}
