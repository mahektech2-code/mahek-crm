"use client";

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import type { AppId } from "@/lib/apps";
import type { AccessRow } from "@/lib/services/access-service";
import type { ErpDesignationDef } from "@/lib/erp/designations";
import { AdminPage } from "../_shell/admin-page";
import { AccessSection } from "../access-section";

/** The Access page: its title, its one action, and the screen that action opens into. */
export function AccessScreen({
  rows,
  designations,
  onlyDesignation,
  isPlatformAdmin,
  onlyApp,
}: {
  rows: AccessRow[];
  designations: ErpDesignationDef[];
  /** Narrowed to the holders of one ERP designation — the Designations page links here. */
  onlyDesignation: string | null;
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
        designations={designations}
        onlyDesignation={onlyDesignation}
        isPlatformAdmin={isPlatformAdmin}
        enabling={enabling}
        onEnablingDone={() => setEnabling(false)}
        onlyApp={onlyApp}
      />
    </AdminPage>
  );
}
