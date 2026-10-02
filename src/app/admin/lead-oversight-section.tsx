"use client";

import * as React from "react";
import { Callout, Card, CardHeader } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * LEAD OVERSIGHT — the funnel's own audit, reached from the Admin Console.
 *
 * It used to be a row in Lead Management's sidebar, drawn to every manager in
 * both apps. What it answers — which shut gates somebody walked past and what
 * was missing when they did, what was done to the funnel under whose hat, and
 * the thresholds in force — is a question about HOW THE FUNNEL IS RUN rather
 * than a worklist, so it lives with the other things about how MahekOne is run.
 *
 * This section holds NO COPY of any of it. The three screens are the ones that
 * have always existed, in the CRM and in the Manager Console, behind their own
 * module grants; this is a way to them from the place an administrator already
 * goes. A second rendering of an audit trail is a second answer to "who passed
 * that gate", and the one that drifts is the one somebody reads.
 *
 * They open in the app that owns them, so the person needs that app — an
 * administrator is not given every app by being an administrator.
 * ------------------------------------------------------------------------- */

const SCREENS: Array<{ title: string; says: string; crm: string; sales: string }> = [
  {
    title: "Overrides",
    says: "Every shut gate a manager passed, what was missing when they did, and the reason code they gave.",
    crm: "/crm/leads/oversight",
    sales: "/sales/leads/oversight",
  },
  {
    title: "Audit",
    says: "The funnel's own audited writes, with the hat that authorised each.",
    crm: "/crm/leads/oversight/audit",
    sales: "/sales/leads/oversight/audit",
  },
  {
    title: "Thresholds",
    says: "The lead settings in force. Read-only here — configuration is authored in this console, under the CRM.",
    crm: "/crm/leads/oversight/settings",
    sales: "/sales/leads/oversight/settings",
  },
];

export function LeadOversightSection() {
  return (
    <div className="mt-5 flex flex-col gap-4">
      <Callout tone="brand">
        <div>
          These open in the app that owns them, behind that app&rsquo;s own Oversight grant — the CRM, or the
          Manager Console. Being an administrator does not by itself give you either app.
        </div>
      </Callout>
      <Card className="overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        <CardHeader title="Where the funnel is audited" />
        <div className="divide-y divide-divider">
          {SCREENS.map((s) => (
            <div key={s.title} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="text-[15px] font-medium text-ink">{s.title}</div>
                <div className="text-[13px] text-pretty text-muted">{s.says}</div>
              </div>
              <div className="flex flex-none items-center gap-4 text-[13px]">
                <a href={s.crm}>Open in the CRM</a>
                <a href={s.sales}>Open in the Manager Console</a>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
