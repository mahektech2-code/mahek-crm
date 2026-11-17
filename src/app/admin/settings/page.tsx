import { redirect } from "next/navigation";
import { ADMIN } from "@/lib/admin-routes";
import { adminContext } from "../_shell/context";

/**
 * Settings is ONE screen with every app's settings in its list (the canvas's
 * frame), so the section lands on the first app this person may configure.
 * What differs from the defaults is the count beside each app and the
 * "Changed only" box on the screen; a contradiction in the stored
 * configuration is shown on the page whose settings it names.
 */
export default async function AllSettings() {
  const ctx = await adminContext();
  redirect(ADMIN.settingsFor(ctx.settingsPages[0].id));
}
