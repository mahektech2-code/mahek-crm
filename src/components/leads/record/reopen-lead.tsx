"use client";

import * as React from "react";

import { Button } from "@/components/console/parts";
import { ReopenLostDialog, type ReopenOffer } from "@/components/leads/lost/reopen-lost-dialog";
import type { LeadStage, LeadSalesType } from "@/lib/lead-labels";
import type { LostLeadRow } from "@/lib/services/lead-lost-service";

/**
 * REVERSE A LOST LEAD FROM ITS OWN RECORD.
 *
 * The Telecaller's and the Sales Manager's records each had this button, and
 * both are retired in favour of this record — so it lives here, drawn only for
 * somebody `offer` says holds one of the two doors. It is the central Lost
 * list's own dialog and the same two actions, which ask the capability, the
 * scope and the lead again; nothing here decides whether a reopen is allowed.
 */
export function ReopenLead({
  customerId,
  name,
  salesType,
  lostReason,
  fromStage,
  offer,
}: {
  customerId: string;
  name: string;
  salesType: LeadSalesType | null;
  lostReason: string | null;
  /** The rung the closing transition left from — null where none is recorded. */
  fromStage: LeadStage | null;
  offer: ReopenOffer;
}) {
  const [open, setOpen] = React.useState(false);
  const lead = {
    id: customerId,
    name,
    salesType,
    lostReason,
    fromStage,
  } as LostLeadRow;
  return (
    <>
      <Button tone="default" onClick={() => setOpen(true)}>
        Reverse lead
      </Button>
      {open ? <ReopenLostDialog lead={lead} offer={offer} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
