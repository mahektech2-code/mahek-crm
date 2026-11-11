import "server-only";
import { isPlatformAdmin, levelInApp } from "@/lib/access-control";

/**
 * Who changes the automatic tasks: a Tasks administrator, or a platform
 * administrator. Everybody holding Set up may READ the rules — what raises a
 * task on somebody's list should never be a mystery — but switching one off
 * stops work reaching people in every app.
 */
export async function canManageAutomations(user: { id: string; role: string }): Promise<boolean> {
  if (await isPlatformAdmin(user)) return true;
  return (await levelInApp(user, "tasks")) === "admin";
}
