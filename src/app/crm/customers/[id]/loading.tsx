import { DetailSkeleton } from "@/components/shell/screen-skeleton";

/**
 * The customer record. It is the heaviest read in the CRM — the timeline, the
 * orders, the bills, the payments and the arrangement — and it is the screen
 * people open with a customer already on the phone, so seeing the furniture
 * arrive matters more here than anywhere.
 */
export default function Loading() {
  return <DetailSkeleton />;
}
