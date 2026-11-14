import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { globalSearch } from "@/lib/queries";
import { fieldTeam } from "@/lib/services/sales-service";

/**
 * WHAT THE MANAGER CONSOLE'S SEARCH BOX ACTUALLY SEARCHES.
 *
 * The box has been in the header of every screen in this app since it shipped
 * and it did nothing at all — no `value`, no `onChange`, no form. It read as
 * the one control on the page that was simply broken, on every screen, all
 * day.
 *
 * **It answers with SALESMEN and SHOPS, and deliberately not orders or bills.**
 * The old placeholder promised "a salesman, customer, order or bill", and two
 * of those four have nowhere to land: this app has no per-order and no per-bill
 * screen, so a result for one could only navigate to a list that does not
 * contain it. A search box that finds a thing and cannot open it is the same
 * lie one level down.
 *
 * The shop half is `globalSearch`, the CRM's own — so the two apps cannot
 * disagree about which shops a person may find, and it is already narrowed by
 * `resolveScope`, which resolves against THIS app because the proxy names it
 * from the URL. The salesman half is `fieldTeam`, which is already narrowed by
 * `managerScope`: a regional manager finds his own people and nobody else's.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ salesmen: [], customers: [] }, { status: 401 });

  const apps = await listUserApps(user.id);
  if (!apps.includes("sales")) {
    return NextResponse.json({ salesmen: [], customers: [] }, { status: 403 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ salesmen: [], customers: [] });

  const needle = q.toLowerCase();
  const digits = q.replace(/\D/g, "");

  const [team, shops] = await Promise.all([fieldTeam(), globalSearch(q)]);

  /* Matched in memory rather than in SQL: `fieldTeam` is the definition of who
     is in the field — it carries the territory narrowing and the handset
     state — and a second query against `users` would be a second answer to
     "who is on this team". The list is the field team, which is eleven people
     here and would be a few hundred at its worst. */
  const salesmen = team
    .filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        (t.email ?? "").toLowerCase().includes(needle) ||
        (digits.length >= 4 && (t.phone ?? "").replace(/\D/g, "").includes(digits)),
    )
    .slice(0, 6)
    .map((t) => ({
      id: t.id,
      name: t.name,
      phone: t.phone,
      active: t.active,
      customerCount: t.customerCount,
    }));

  return NextResponse.json({ salesmen, customers: shops.customers });
}
