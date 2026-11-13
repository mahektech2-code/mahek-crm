import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerPeople } from "@/lib/locker/service";
import { offboardingView, revealedBy } from "@/lib/locker/vault-service";
import { PageHead } from "../_ui/kit";
import { OffboardScreen } from "./offboard-screen";

export const metadata = { title: "Offboard" };

export default async function OffboardPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "locker.offboard");
  const [{ id }, v, people] = await Promise.all([searchParams, offboardingView(), lockerPeople()]);
  const sel = v.cases.find((c) => c.id === id) ?? v.cases.find((c) => !c.completedAt) ?? null;
  const revealed = sel ? await revealedBy(sel.userId) : [];
  return (
    <>
      <PageHead
        crumb="Locker · Operations"
        title={sel ? `Offboarding — ${sel.name}` : "Offboard"}
        sub={sel ? `Started by ${sel.by}. Every login they could reach is changed, not just removed — removing an account does not make somebody forget a password.` : "When somebody leaves, everything they owned, held or saw in the Locker, as a list that cannot be signed off while anything is open."}
      />
      <OffboardScreen
        people={v.people.map((p) => ({ v: p.id, l: p.active ? p.name : `${p.name} · left` }))}
        owners={people.map((p) => ({ v: p.id, l: p.name }))}
        cases={v.cases}
        selId={sel?.id ?? null}
        revealed={revealed.map((r) => ({ id: r.id, title: r.title, tier: r.tier, at: r.at?.toISOString() ?? "" }))}
      />
    </>
  );
}
