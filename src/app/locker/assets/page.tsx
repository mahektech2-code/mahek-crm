import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { RegisterScreen } from "./register-screen";
import { loadRegister, viewOf } from "./load";

export const metadata = { title: "All assets" };
export const dynamic = "force-dynamic";

export default async function AllAssetsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await requireUser();
  const access = await lockerAccess(user.id);
  /* All assets is the register across whatever categories a person holds; with none, the guard sends them on. */
  if (!access.has("locker.assets") && !access.categories.length) await requireModule(user.id, "locker.assets");
  const [{ view }, d] = await Promise.all([searchParams, loadRegister(user.id)]);
  return (
    <RegisterScreen
      rows={d.rows}
      cat={null}
      me={user.id}
      initialView={viewOf(view)}
      title="All assets"
      sub="Every document, licence, subscription and contract. Sorted by days remaining; the left edge shows how important it is, the badge shows its status."
      crumb="Locker · Register"
      canAdd={d.canAdd}
      entities={d.entities}
      sites={d.sites}
      catsAllowed={d.access.categories}
    />
  );
}
