import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { enquiryDashboardCounts } from "@/lib/services/enquiry-service";
import { PageHeader, Card, MetricStrip } from "@/components/ui/primitives";
import { STAGE_LABEL } from "@/lib/enquiry-labels";

export const metadata = { title: "Website Enquiries — Overview" };

export default async function EnquiriesOverviewPage() {
  const user = await requireUser();

  // Overview is a module like any other, and it is the app's own root — so it
  // cannot have a folder layout to guard it, and the guard runs here instead.
  await requireModule(user.id, "enquiries.overview");

  const counts = await enquiryDashboardCounts();

  const metrics = [
    { label: "Total enquiries", value: String(counts.total) },
    { label: "New", value: String(counts.byStage.new) },
    { label: "Contacted", value: String(counts.byStage.contacted) },
    { label: "Follow-up", value: String(counts.byStage.follow_up) },
    { label: "Qualified", value: String(counts.byStage.qualified) },
    { label: "Converted", value: String(counts.byStage.converted), tone: "success" as const },
    { label: "Closed", value: String(counts.byStage.closed) },
    { label: "Unassigned", value: String(counts.unassigned), tone: counts.unassigned > 0 ? "danger" as const : undefined },
    { label: "High / urgent priority", value: String(counts.highOrUrgent), tone: counts.highOrUrgent > 0 ? "danger" as const : undefined },
  ];

  return (
    <div className="max-w-[1200px] px-6 pt-6 pb-10">
      <PageHeader
        title="Website Enquiries"
        subtitle="Every enquiry from the website and beyond, from first contact through to delivery."
        actions={
          <Link
            href="/enquiries/list"
            className="inline-flex h-9 items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
          >
            Open the worklist
          </Link>
        }
      />

      <MetricStrip metrics={metrics} />

      {counts.total === 0 ? (
        <Card className="px-6 py-14 text-center">
          <div className="text-lg font-semibold text-ink">No enquiries yet</div>
          <p className="mx-auto mt-1.5 max-w-[440px] text-[15px] text-muted">
            Once a website enquiry arrives it will appear here, unassigned, ready to be worked.
          </p>
        </Card>
      ) : (
        <Card className="px-5 py-4">
          <div className="text-sm text-muted">
            {counts.unassigned > 0 ? (
              <>
                <span className="font-medium text-ink">{counts.unassigned}</span> enquir
                {counts.unassigned === 1 ? "y is" : "ies are"} waiting to be assigned. Open the{" "}
                <Link href="/enquiries/list?assigned=unassigned" className="text-brand hover:text-brand-hover">
                  worklist
                </Link>{" "}
                to hand them out.
              </>
            ) : (
              "Every enquiry currently has somebody assigned."
            )}
          </div>
        </Card>
      )}

      <p className="mt-4 text-xs text-muted">
        Stages: {Object.values(STAGE_LABEL).join(" · ")}
      </p>
    </div>
  );
}
