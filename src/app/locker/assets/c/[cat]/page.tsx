import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { CATEGORY, categoryModuleSlug } from "@/lib/locker/catalogue";
import { RegisterScreen } from "../../register-screen";
import { loadRegister, viewOf } from "../../load";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ cat: string }> }) {
  const { cat } = await params;
  return { title: CATEGORY[cat]?.name ?? "Register" };
}

export default async function CategoryPage({ params, searchParams }: { params: Promise<{ cat: string }>; searchParams: Promise<{ view?: string }> }) {
  const user = await requireUser();
  const [{ cat }, { view }] = await Promise.all([params, searchParams]);
  if (!CATEGORY[cat]) notFound();
  const access = await lockerAccess(user.id);
  if (!access.catOk(cat)) await requireModule(user.id, `locker.cat.${categoryModuleSlug(cat)}`);
  if (!access.catOk(cat)) notFound();
  const d = await loadRegister(user.id);
  return (
    <RegisterScreen
      rows={d.rows}
      cat={cat}
      me={user.id}
      initialView={viewOf(view)}
      title={CATEGORY[cat].name}
      sub={
        cat === "hazardous"
          ? "⚠ Licences for storing and handling flammable solvents. If one runs out, work stops."
          : "Every document, licence, subscription and contract. Sorted by days remaining; the left edge shows how important it is, the badge shows its status."
      }
      crumb="Locker · Register"
      canAdd={d.canAdd}
      entities={d.entities}
      sites={d.sites}
      catsAllowed={d.access.categories}
    />
  );
}
