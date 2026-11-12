import "server-only";
import { taskPowersOf } from "./powers-service";

/**
 * Who changes the automatic tasks: whoever holds "Run automatic tasks" — every
 * Tasks administrator and platform administrator, and anybody it was ticked
 * for on the Access screen. Everybody holding Set up may READ the rules — what
 * raises a task on somebody's list should never be a mystery — but switching
 * one off stops work reaching people in every app.
 */
export async function canManageAutomations(user: { id: string; role: string }): Promise<boolean> {
  return (await taskPowersOf(user)).has("automations");
}
