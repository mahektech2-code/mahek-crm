import { requireUser } from "@/lib/auth";

/*
 * THE GUARD MOVED DOWN, and this layout deliberately no longer carries one.
 *
 * It used to `requireModule(user.id, "sales.leads")`, which was right while
 * everything under `/sales/leads` was one module. It is now nine: Funnel,
 * Intake, Qualification, Commercial, Appointments, Next actions, Handovers and
 * Oversight all live under this path and are separately grantable. A guard
 * here would mean somebody granted only Qualification was redirected away from
 * it by the folder above — a grant they hold, refused by a layout that knows
 * nothing about it.
 *
 * So each module folder carries its own, and the two screens that ARE
 * `sales.leads` — the book at this path and the record under `[id]` — carry
 * theirs where they are. Nothing is ungated: `lead-nav.test.ts` asserts every
 * section in `LEAD_SECTIONS` names a real module, and the Sales layout above
 * has already refused anybody without the app.
 */
export default async function LeadsLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return children;
}
