"use client";

import * as React from "react";
import type { AppId } from "@/lib/apps";
import type { AccessRow } from "@/lib/services/access-service";
import type { AccessView } from "@/lib/services/admin-access-view-service";
import type { ErpDesignationDef } from "@/lib/erp/designations";
import { AccessSection } from "../access-section";

/** The Access page: the list, and the grant dialog its "Give somebody access" opens. */
export function AccessScreen({
  rows,
  designations,
  onlyDesignation,
  isPlatformAdmin,
  onlyApp,
  view,
  now,
  manage,
}: {
  rows: AccessRow[];
  designations: ErpDesignationDef[];
  /** Narrowed to the holders of one ERP designation — the Designations page links here. */
  onlyDesignation: string | null;
  /** Admin on the Admin Console — the only person whose saves the server accepts. */
  isPlatformAdmin: boolean;
  onlyApp: AppId | null;
  view: AccessView;
  now: number;
  manage: string | null;
}) {
  const [enabling, setEnabling] = React.useState(false);
  return (
    <AccessSection
      rows={rows}
      designations={designations}
      onlyDesignation={onlyDesignation}
      isPlatformAdmin={isPlatformAdmin}
      enabling={enabling}
      onEnable={() => setEnabling(true)}
      onEnablingDone={() => setEnabling(false)}
      onlyApp={onlyApp}
      view={view}
      now={now}
      manage={manage}
    />
  );
}
