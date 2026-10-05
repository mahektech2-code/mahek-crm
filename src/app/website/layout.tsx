import { requireUser } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/toast";
import { WebsiteShell } from "./website-shell";

/**
 * PROTOTYPE gate.
 *
 * This checks that somebody is actually signed in to MahekOne — it does NOT
 * check `listUserApps(user.id).includes("website")`, because "website" is
 * not yet a real value in the `app_id` Postgres enum (that migration is
 * explicitly out of scope for this UI-only prototype phase; see the audit).
 * Wiring the real per-app grant check is a one-line change for the
 * implementation phase, once that enum value exists — this file is written
 * so that's the only thing that has to change here.
 */
export default async function WebsiteLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <ToastProvider>
      <WebsiteShell userName={user.name}>{children}</WebsiteShell>
    </ToastProvider>
  );
}
