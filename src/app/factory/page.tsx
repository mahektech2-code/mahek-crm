import { bootstrap, factoryContext } from "@/lib/factory/server";
import { initialsOf } from "@/lib/format";
import { FactoryApp } from "./_ui/factory-app";

export const dynamic = "force-dynamic";

/**
 * The whole app is one client screen; the server hands it who is signed in
 * and the floor as it is now, and every later change goes through the
 * actions in `lib/actions/factory.ts`. Somebody signed in to MahekOne without
 * the Factory app lands on its own sign-in, which is the right door for a
 * shared station phone.
 */
export default async function FactoryPage() {
  const fc = await factoryContext();
  const data = fc ? await bootstrap(fc) : null;
  const me = fc ? { key: fc.user.id, n: fc.user.name, ini: initialsOf(fc.user.name), head: fc.head, area: fc.area, lang: fc.lang } : null;
  return <FactoryApp initialMe={me} initialData={data} dev={process.env.NODE_ENV !== "production"} />;
}
