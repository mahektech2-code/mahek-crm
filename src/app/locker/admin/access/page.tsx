import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { modulesForApp } from "@/lib/modules";
import { lockerHolders } from "@/lib/locker/ops-core";
import { lockerPeople } from "@/lib/locker/service";
import { PageHead } from "../../_ui/kit";
import { AccessScreen } from "./access-screen";

export const metadata = { title: "Access" };

export default async function AccessPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.access");
  const [holders, people] = await Promise.all([lockerHolders(), lockerPeople()]);
  return (
    <>
      <PageHead crumb="Locker · Admin" title="Access" sub="Permissions are granted screen by screen. Each person sees exactly the sidebar entries ticked here, and nothing else. Changes apply immediately, are recorded, and the person is told." />
      <AccessScreen
        me={user.id}
        holders={holders}
        people={people.map((p) => ({ v: p.id, l: p.title ? `${p.name} · ${p.title}` : p.name }))}
        modules={modulesForApp("locker").map((m) => ({ key: m.key, label: m.label, group: m.group, note: m.note ?? "", off: !!m.offByDefault }))}
      />
    </>
  );
}
