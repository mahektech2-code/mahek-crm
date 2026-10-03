import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { ComponentsScreen } from "../components-section";

/**
 * The design system, rendered — every component in every state. A handoff
 * artifact for whoever builds the screens, and nothing anybody working a queue
 * needs, so it sits under For builders.
 */
export default async function ComponentsPage() {
  await requirePlatformAdmin();
  return (
    <AdminPage
      title="Components"
      subtitle="Every component in every state, so a change to a token or a primitive can be checked in one place rather than hunted for across fifteen screens."
    >
      <ComponentsScreen />
    </AdminPage>
  );
}
