"use client";

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import type { AppId } from "@/lib/apps";
import type { AccessRow } from "@/lib/services/access-service";
import { AdminPage } from "../_shell/admin-page";
import { AccessSection } from "../access-section";

/** The Access page: its title, its one action, and the screen that action opens into. */
export function AccessScreen({
  rows,
  isPlatformAdmin,
  onlyApp,
}: {
  rows: AccessRow[];
  /** Admin on the Admin Console — the only person whose saves the server accepts. */
  isPlatformAdmin: boolean;
  onlyApp: AppId | null;
}) {
  const [enabling, setEnabling] = React.useState(false);
  return (
    <AdminPage
      title="Access"
      subtitle="Who can open which app, and how far into it. People come from the employee master, so access starts with somebody who actually works here."
      actions={
        isPlatformAdmin ? (
          <Button variant="primary" onClick={() => setEnabling(true)}>
            Enable access
          </Button>
        ) : null
      }
    >
      <AccessSection
        rows={rows}
        isPlatformAdmin={isPlatformAdmin}
        enabling={enabling}
        onEnablingDone={() => setEnabling(false)}
        onlyApp={onlyApp}
      />
    </AdminPage>
  );
}
