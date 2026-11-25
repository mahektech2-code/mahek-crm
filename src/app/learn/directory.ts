import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";

/* ---------------------------------------------------------------------------
 * WHO TO CONTACT (PRD §14). The `hire.directory` setting, one desk a line:
 *   Department | work email or work number | what to ask them about
 * Each line becomes a PERSON at read time — by the email or the work number,
 * the identifiers a login uses, never by a typed name — so a renamed
 * colleague is shown under their current name. A line that finds nobody is
 * left out and counted, so the screen can say the directory needs fixing.
 * ------------------------------------------------------------------------- */

export type DirectoryEntry = { desk: string; name: string; initials: string; about: string; phone: string | null; email: string | null };

const last10 = (s: string) => s.replace(/\D/g, "").slice(-10);

export async function directory(): Promise<{ entries: DirectoryEntry[]; unresolved: number }> {
  const raw = (await getConfig())["hire.directory"] ?? "";
  const lines = raw
    .split("\n")
    .map((l) => l.split("|").map((x) => x.trim()))
    .filter((p) => p.length >= 2 && p[0] && p[1]);
  if (!lines.length) return { entries: [], unresolved: 0 };
  const emails = lines.map((p) => p[1].toLowerCase()).filter((x) => x.includes("@"));
  const phones = lines.map((p) => p[1]).filter((x) => !x.includes("@")).map(last10).filter((x) => x.length === 10);
  const found = await db
    .select({ id: users.id, name: users.name, email: users.email, phone: users.phone, initials: users.initials, active: users.active })
    .from(users)
    .where(sql`${users.active} and (${emails.length ? inArray(sql`lower(${users.email})`, emails) : sql`false`} or ${phones.length ? inArray(users.phone, phones) : sql`false`})`);
  const entries: DirectoryEntry[] = [];
  let unresolved = 0;
  for (const [desk, who, about = ""] of lines) {
    const key = who.includes("@") ? who.toLowerCase() : last10(who);
    const u = found.find((f) => (who.includes("@") ? f.email?.toLowerCase() === key : f.phone != null && last10(f.phone) === key));
    if (!u) {
      unresolved += 1;
      continue;
    }
    entries.push({ desk, name: u.name, initials: u.initials ?? u.name.slice(0, 2).toUpperCase(), about, phone: u.phone, email: u.email });
  }
  return { entries, unresolved };
}
