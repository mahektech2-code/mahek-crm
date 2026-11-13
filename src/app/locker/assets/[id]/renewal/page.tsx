import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { renewalCase, toLite } from "@/lib/locker/register-service";
import { stampIst } from "@/lib/locker/style";
import { RenewalScreen } from "./renewal-screen";

export const metadata = { title: "Renewal task" };
export const dynamic = "force-dynamic";

export default async function RenewalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const access = await lockerAccess(user.id);
  if (!access.has("locker.renewals") && !access.categories.length) await requireModule(user.id, "locker.renewals");
  const { id } = await params;
  const d = await renewalCase(user.id, id);
  if (!d) notFound();
  const r = d.openRenewal;
  const done = d.history[0];
  return (
    <RenewalScreen
      a={toLite(d.asset)}
      typeName={d.asset.type.name}
      authority={d.asset.extra.issued_by || d.asset.type.authority}
      leadDays={d.asset.type.leadDays}
      validityMonths={d.asset.type.validityMonths}
      typicalCost={d.asset.type.typicalCostPaise}
      model={d.asset.model}
      approverName={d.approverName}
      externalContact={d.asset.externalContact}
      paymentMethod={d.paymentMethod ? `${d.paymentMethod.label} ····${d.paymentMethod.last4}` : null}
      stage={d.asset.stage}
      newer={d.newer ? { id: d.newer.id, endDate: d.newer.endDate } : null}
      lastCompleted={done && !r ? { at: done.completedAt ? stampIst(done.completedAt) : "" } : null}
      renewal={
        r
          ? {
              id: r.id,
              step: r.step,
              checklist: r.checklist,
              assignedToId: r.assignedToId,
              assignedName: r.assignedName,
              appliedOn: r.appliedOn,
              ackNo: r.ackNo,
              costPaise: r.costPaise,
              notes: r.notesList.map((n) => ({ who: n.who, at: n.at ? stampIst(n.at) : "", t: n.t })),
            }
          : null
      }
      people={d.people.map((p) => ({ id: p.id, name: p.name }))}
      canEdit={d.canEdit}
      today={d.day}
    />
  );
}
