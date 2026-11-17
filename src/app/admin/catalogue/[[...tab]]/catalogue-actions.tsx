"use client";

import * as React from "react";
import Link from "next/link";
import { ADMIN } from "@/lib/admin-routes";
import type { CatalogueData } from "../../catalogue-data";
import { NewSkuDialog } from "../../new-sku-dialog";
import { btnClass } from "../../_shell/kit";

/**
 * The catalogue's title row, the canvas's way: find a product, import, add a
 * SKU. The search is the SKU list's own filter — Enter puts it in the address,
 * so a found list is a screen somebody can send to somebody else.
 */
export function CatalogueActions({
  query,
  hierarchy,
  canWrite,
}: {
  query: string;
  hierarchy: CatalogueData["hierarchy"];
  canWrite: boolean;
}) {
  const [q, setQ] = React.useState(query);
  const [adding, setAdding] = React.useState(false);

  return (
    <>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const params = new URLSearchParams();
          if (q.trim()) params.set("q", q.trim());
          window.location.href = `${ADMIN.catalogue("skus")}${params.size ? `?${params}` : ""}`;
        }}
        aria-label="Find a product"
        placeholder="Name, alias or Product ID"
        className="h-9 w-[260px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink placeholder:text-muted focus:border-brand focus:outline-none"
      />
      <Link href={ADMIN.catalogue("import")} className={btnClass("plain")}>
        Import
      </Link>
      <button
        type="button"
        disabled={!canWrite}
        title={canWrite ? undefined : "Configuration is changed by a manager."}
        onClick={() => setAdding(true)}
        className={btnClass("primary")}
      >
        Add SKU
      </button>
      <NewSkuDialog
        open={adding}
        hierarchy={hierarchy}
        onClose={() => setAdding(false)}
        onCreated={(sku) => {
          /* Land on the new row with its detail open, through the address. */
          const params = new URLSearchParams({ q: sku.name, open: sku.productId });
          window.location.href = `${ADMIN.catalogue("skus")}?${params}`;
        }}
      />
    </>
  );
}
