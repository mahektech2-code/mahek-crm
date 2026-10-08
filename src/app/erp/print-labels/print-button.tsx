"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { erpMarkLabelsPrinted } from "@/lib/actions/erp-trace";
import { Button } from "@/components/ui/primitives";

/** Sends the sheet to the printer, and — for product labels — records that each box's label was printed. */
export function PrintButton({ ids, label }: { ids: string[]; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {error ? <span className="text-[12px] text-danger">{error}</span> : null}
      <Button
        variant="primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            if (ids.length) {
              const res = await erpMarkLabelsPrinted(ids);
              if (!res.ok) setError(res.error);
            }
            window.print();
            router.refresh();
          })
        }
      >
        {label}
      </Button>
    </span>
  );
}
