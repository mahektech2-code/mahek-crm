import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerTypes } from "@/lib/locker/service";
import { PageHead } from "../../_ui/kit";
import { TypesScreen } from "./types-screen";

export const metadata = { title: "Types" };

export default async function TypesPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.types");
  const types = await lockerTypes();
  return (
    <>
      <PageHead crumb="Locker · Admin" title="Asset types" sub="Adding a type is authoring, not engineering. The add-asset form renders from these: how long each lasts, how early it must be renewed, the steps and the extra fields." />
      <TypesScreen types={types.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() }))} />
    </>
  );
}
