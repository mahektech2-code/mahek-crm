"use client";

import * as React from "react";
import { Badge, Card, CardHeader, Select, Th, Td, Tr } from "@/components/ui/primitives";
import { crmSchema } from "@/lib/config/schema-contract";
import { useAdmin } from "./store";

/* ---------------------------------------------------------------------------
 * The schema inspector — the one screen in this file that ever read anything
 * real. It shows exactly what an app publishes, which is how you find out why
 * a setting does not appear in the console.
 *
 * Everything else that lived here — a contract validator against endpoints
 * that do not exist, feature flags with no table behind them, a per-app
 * dashboard of invented counts, a migration screen that made up its rows —
 * went when the platform sections were wired to the database. A screen that
 * cannot be honest is worse than no screen, because it is believed.
 * ------------------------------------------------------------------------- */

export function SchemaInspector() {
  const { registry } = useAdmin();
  const [appId, setAppId] = React.useState("crm");
  const app = registry.find((a) => a.id === appId)!;
  const live = app.status === "Live";
  const schema = crmSchema();
  const fields = live
    ? schema.tabs.flatMap((t) => t.groups.flatMap((g) => g.fields.map((f) => ({ tab: t.label, ...f }))))
    : [];

  return (
    <div>
      <div className="mt-5 flex items-center gap-3">
        <Select value={appId} onChange={(e) => setAppId(e.target.value)} className="w-[280px]">
          {registry.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>

      <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader
          title="Declared schema"
          hint="Exactly what the app is publishing. When a setting does not appear in the console, this is where you find out why."
        />
        {!live ? (
          <div className="px-5 py-8 text-center text-sm text-muted">
            {app.name} publishes no schema yet, so it has no settings section.
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="[&_td]:whitespace-nowrap">
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Sub-tab</Th>
                  <Th>Type</Th>
                  <Th>Default</Th>
                  <Th>Range</Th>
                  <Th>Restricted</Th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f, i) => (
                  <Tr key={f.key} className={i % 2 ? "bg-canvas" : ""}>
                    <Td>
                      <span className="font-mono text-[13px] text-ink">{f.key}</span>
                    </Td>
                    <Td>{f.tab}</Td>
                    <Td>
                      <Badge tone="neutral">{f.control}</Badge>
                    </Td>
                    <Td className="max-w-[280px] truncate">
                      {typeof f.def === "object" && f.def !== null
                        ? Object.values(f.def as Record<string, unknown>).join(" / ")
                        : String(f.def)}
                    </Td>
                    <Td>{f.min !== undefined ? `${f.min}–${f.max}` : "—"}</Td>
                    <Td>{f.adminOnly ? <Badge tone="warn">Platform admin</Badge> : "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------ contract validation */
