import { ListSkeleton } from "@/components/shell/screen-skeleton";

/**
 * THE CRM'S LOADING BOUNDARY, and the one file that decides whether a tab
 * change feels instant.
 *
 * It sits at the app root rather than on each screen because a boundary
 * applies to its own segment AND everything below it — so this one covers all
 * fourteen CRM screens, and a screen that wants a different shape adds its own
 * `loading.tsx` beside its page (the dashboard does).
 *
 * Most CRM screens are a list of customers, bills, reminders or complaints,
 * so a list is the honest default.
 */
export default function Loading() {
  return <ListSkeleton />;
}
