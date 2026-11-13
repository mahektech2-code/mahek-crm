import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { RegisterScreen } from "../assets/register-screen";
import { loadRegister, viewOf } from "../assets/load";

export const metadata = { title: "My assets" };
export const dynamic = "force-dynamic";

export default async function MyAssetsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "locker.myassets");
  const [{ view }, d] = await Promise.all([searchParams, loadRegister(user.id)]);
  return (
    <RegisterScreen
      rows={d.rows}
      cat={null}
      me={user.id}
      initialView={view ? viewOf(view) : "mine"}
      title="My assets"
      sub="Everything you are primary or backup owner of."
      crumb="Locker · My work"
      canAdd={d.canAdd}
      entities={d.entities}
      sites={d.sites}
      catsAllowed={d.access.categories}
    />
  );
}
