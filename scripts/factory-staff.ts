/**
 * Puts a person on the factory floor: their team, the words under their name,
 * their badge, and — optionally — their place in the team's standing crew.
 * Grants the Factory app if they do not hold it (manager for a Production
 * Head, associate for everybody else). The person sets their own PIN on first
 * sign-in, with an SMS code to their HRMS mobile; `--pin` is for a pilot only.
 *
 *   npm run factory:staff -- 9850220231 --area=mixing --role="Machine operator" --badge=EMP-0231 --crew=operator
 *   npm run factory:staff -- vikram@mahek.in --area=head
 *   npm run factory:staff -- 9850220207 --area=mixing --unconfirmed     # name or role still with HR (PRD §5.1)
 *   npm run factory:staff -- --list
 *
 * Areas: head, mixing, filling, packing, dispatch, qc.
 * Crew roles: owner, operator, helper, verifier.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { hashPassword } from "@/lib/auth";
import { findAccount } from "@/lib/services/otp-service";

const AREAS = ["head", "mixing", "filling", "packing", "dispatch", "qc"];
const CREW = ["owner", "operator", "helper", "verifier"];

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith("--" + name + "="));
  return a ? a.slice(name.length + 3) : undefined;
}
const flag = (name: string) => process.argv.includes("--" + name);

async function main() {
  if (flag("list")) {
    const rows = (await db.execute(sql`
      select u.name, u.phone, s.area, s.role_label, s.badge_code, s.hr_confirmed, s.pin_hash is not null as has_pin,
             (select string_agg(proc || ':' || role, ', ') from factory_team_defaults d where d.user_id = s.user_id) as crew
        from factory_staff s join users u on u.id = s.user_id order by s.area, u.name`)) as unknown as Record<string, unknown>[];
    console.table(rows);
    return;
  }
  const who = process.argv.slice(2).find((x) => !x.startsWith("--"));
  const area = arg("area");
  if (!who || !area || !AREAS.includes(area)) throw new Error("Usage: npm run factory:staff -- <mobile|email> --area=" + AREAS.join("|") + " [--role=…] [--badge=…] [--crew=" + CREW.join("|") + "] [--unconfirmed]");
  const user = await findAccount(who);
  if (!user) throw new Error("No MahekOne account for " + who + ". Create it from Admin Console → Access first.");
  const crew = arg("crew");
  if (crew && !CREW.includes(crew)) throw new Error("--crew must be one of " + CREW.join(", "));
  if (crew && area === "head") throw new Error("A Production Head is not on a process crew.");
  const pin = arg("pin");
  if (pin && !/^\d{4}$/.test(pin)) throw new Error("--pin is 4 numbers");

  const level = area === "head" ? "manager" : "associate";
  await db.execute(sql`
    insert into app_access (id, user_id, app, role) values (${"aca_" + randomUUID().slice(0, 12)}, ${user.id}, 'factory', ${level})
    on conflict do nothing`);
  await db.execute(sql`
    insert into factory_staff (user_id, area, role_label, badge_code, hr_confirmed, pin_hash)
    values (${user.id}, ${area}, ${arg("role") ?? null}, ${arg("badge") ?? null}, ${!flag("unconfirmed")}, ${pin ? await hashPassword(pin) : null})
    on conflict (user_id) do update set
      area = excluded.area,
      role_label = coalesce(excluded.role_label, factory_staff.role_label),
      badge_code = coalesce(excluded.badge_code, factory_staff.badge_code),
      hr_confirmed = excluded.hr_confirmed,
      pin_hash = coalesce(excluded.pin_hash, factory_staff.pin_hash),
      updated_at = now()`);
  if (crew) {
    /* One owner and one operator per process; any number of helpers. */
    if (crew === "owner" || crew === "operator") await db.execute(sql`delete from factory_team_defaults where proc = ${area} and role = ${crew}`);
    await db.execute(sql`insert into factory_team_defaults (proc, role, user_id) values (${area}, ${crew}, ${user.id}) on conflict do nothing`);
  }
  console.log(`${user.name} is on the floor: ${area}${crew ? " · " + crew : ""}${level === "manager" ? " · Production Head" : ""}.`);
}

main()
  .then(() => db.$client.end())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await db.$client.end();
    process.exit(1);
  });
