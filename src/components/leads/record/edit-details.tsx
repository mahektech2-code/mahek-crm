"use client";

import { Button } from "@/components/console/parts";
import { EditLeadButton } from "./lead-edit-dialog";

/**
 * EDIT THE LEAD'S DETAILS from the unified record — the CRM's and the Sales
 * Dashboard's. It opens the one lead edit modal (`lead-edit-dialog.tsx`);
 * drawn for anybody holding `lead.work`, and the modal's load and save ask
 * that and the lead's scope again on the server.
 */
export function EditDetails({ customerId }: { customerId: string }) {
  return (
    <EditLeadButton
      customerId={customerId}
      renderButton={(open) => (
        <Button size="sm" tone="quiet" title="Correct this lead's name, contact, city, phone and product." onClick={open}>
          Edit details
        </Button>
      )}
    />
  );
}
