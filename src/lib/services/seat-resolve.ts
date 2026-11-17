import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { employees, users } from "@/db/schema";
import type { SeatPick } from "@/lib/new-customer";

/* A seat picked on a form, resolved against the database — never a name taken
   off the request. Shared by Add customer and the lead bypass, which ask the
   same question of the same pickers. Not in a "use server" file: everything
   exported there becomes a URL anybody can post to. */

export type ResolvedSeat = { userId: string | null; name: string | null };

/** The seat, or the sentence explaining why it cannot be used. */
export async function resolveSeat(seat: SeatPick, label: string): Promise<ResolvedSeat | string> {
  if (seat.kind === "none") return { userId: null, name: null };
  if (seat.kind === "user") {
    const [u] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, seat.userId), eq(users.active, true)))
      .limit(1);
    return u ? { userId: u.id, name: u.name } : `The ${label} no longer has an active account. Pick somebody else.`;
  }
  const [e] = await db
    .select({ name: employees.name })
    .from(employees)
    .where(and(eq(employees.id, seat.employeeId), eq(employees.status, "active")))
    .limit(1);
  if (!e) return `The ${label} is no longer on the current staff list.`;
  /* EVERY EMPLOYEE HAS AN ACCOUNT (owner, 2026-11-18), so a person picked
     from the staff list is held by it — the seat is an id, and the name shown
     comes from the account. Held as a bare name only if, for a moment, the
     account has not been made yet; `ensureEmployeeAccounts` is asked first. */
  const account = await employeesAccount(seat.employeeId);
  return account ? { userId: account.id, name: account.name } : { userId: null, name: e.name };
}

/** The one account an employee has — made now if, for a moment, it was not yet. */
export async function employeesAccount(employeeId: string): Promise<{ id: string; name: string } | null> {
  const find = async () =>
    (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.employeeId, employeeId)).limit(1))[0] ?? null;
  const found = await find();
  if (found) return found;
  const { ensureEmployeeAccounts } = await import("@/lib/services/person-identity-service");
  await ensureEmployeeAccounts();
  return find();
}
