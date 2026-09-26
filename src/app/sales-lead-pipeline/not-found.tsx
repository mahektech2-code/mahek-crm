import Link from "next/link";
import { Card } from "@/components/ui/primitives";

/**
 * A lead that does not exist and a lead outside this manager's territory answer
 * identically, on purpose — a 404 that told them apart would make the URL a way
 * to find out whose book an id belongs to.
 */
export default function NotFound() {
  return (
    <div className="p-6">
      <Card className="px-6 py-10 text-center">
        <div className="text-[15px] font-semibold text-ink">Lead not found</div>
        <div className="mt-1 text-sm text-muted">
          It may have been removed, or it is not in the part of the book you cover.
        </div>
        <Link href="/sales-lead-pipeline/list" className="mt-4 inline-block text-sm font-medium text-brand hover:text-brand-hover">
          ← Back to All Leads
        </Link>
      </Card>
    </div>
  );
}
