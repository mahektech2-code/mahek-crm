"use client";

import type { ComponentProps } from "react";
import { ListScreen } from "@/app/erp/_ui/list-screen";
import type { HrmsListSpec } from "@/lib/hrms/extras";
import { Above } from "./above";

/**
 * The list screen with the HRMS strip above it. The strip is built HERE, on
 * the client, from the spec's data: an element built on the server and handed
 * to a client component as a prop trips React's key warning.
 */
export function HrmsList(props: Omit<ComponentProps<typeof ListScreen>, "above" | "spec"> & { spec: HrmsListSpec }) {
  const extras = props.spec.hrms;
  return <ListScreen {...props} above={extras ? <Above extras={extras} rows={props.rows} /> : null} />;
}
