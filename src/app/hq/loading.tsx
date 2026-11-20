import { DashboardSkeleton } from "@/components/shell/screen-skeleton";

/**
 * The Founder Command Centre's loading boundary: its screens are figures and
 * panels, so a dashboard is the honest shape. See `src/app/crm/loading.tsx`.
 */
export default function Loading() {
  return <DashboardSkeleton />;
}
