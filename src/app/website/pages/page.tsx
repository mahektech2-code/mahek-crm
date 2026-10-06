"use client";

import * as React from "react";
import { Card, CardHeader, PageHeader, Badge } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { StatusBadge } from "../status-badge";
import { PAGES, type SitePage } from "../mock-data";

export default function PagesPage() {
  const [open, setOpen] = React.useState<SitePage | null>(null);

  return (
    <div className="p-6">
      <PageHeader
        title="Pages"
        subtitle="About, Manufacturing, Distributor and Contact — their sections and copy. These are the public site's own pages, not something created here."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {PAGES.map((p) => (
          <Card key={p.id} className="cursor-pointer hover:bg-canvas" onClick={() => setOpen(p)}>
            <CardHeader
              title={p.title}
              hint={`/${p.slug}`}
              action={<Badge tone="brand">{p.sections.length} sections</Badge>}
            />
          </Card>
        ))}
      </div>

      <Drawer open={open !== null} onClose={() => setOpen(null)} width={480} label="Page sections">
        {open ? (
          <>
            <DrawerHeader onClose={() => setOpen(null)}>{open.title}</DrawerHeader>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="flex flex-col gap-2">
                {open.sections.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-[4px] border border-line px-3 py-2.5">
                    <span className="text-sm text-body">{s.heading}</span>
                    <StatusBadge status={s.status} />
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
