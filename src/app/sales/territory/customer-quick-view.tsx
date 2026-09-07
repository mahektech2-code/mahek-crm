"use client";

import * as React from "react";
import { Badge, Dot } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { accountTypeLabel } from "@/lib/account-types";
import { customerStatusLabel, money, phoneDisplay, shortDate } from "@/lib/format";
import { NEXT_STEP_LABELS, type NextStepKind } from "@/lib/next-step-labels";

/* ---------------------------------------------------------------------------
 * What a shop pin opens into on Territory's map.
 *
 * Reads `/api/sales/customer-quick-view` — the same two functions the CRM's
 * own record page and Information tab call (`getCustomer`,
 * `customerInformation`) — so a figure shown here can never disagree with
 * the CRM's own reading of the same account. Fetched on open rather than
 * carried on every pin: a territory can be a few thousand shops, and most
 * pins are never clicked.
 * ------------------------------------------------------------------------- */

type QuickViewCustomer = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string;
  whatsappPhone: string | null;
  address: string | null;
  city: string;
  region: string | null;
  beat: string | null;
  kind: "lead" | "customer";
  thirdParty: boolean;
  status: string;
  slowPayer?: boolean;
  lastOrderDate: string | null;
  outstanding: number;
  ownerName: string | null;
  salesAmName: string | null;
  salesManagerName: string | null;
  backOfficeAmName: string | null;
  nextStep: {
    kind: NextStepKind;
    date: string | null;
    headline: string | null;
    detail: string | null;
  } | null;
};

type QuickViewInfo = {
  purchase: {
    lastOrderDate: string | null;
    lastOrderDaysAgo: number | null;
    cycleDays: number;
    cycleIsDefault: boolean;
    nextOrderDate: string | null;
  } | null;
  recentCalls: Array<{
    id: string;
    at: string;
    outcome: string | null;
    notes: string | null;
  }>;
};

export function CustomerQuickView({
  customerId,
  onClose,
}: {
  /** Null closes the drawer; a fresh id opens fresh. */
  customerId: string | null;
  onClose: () => void;
}) {
  return (
    <Drawer open={customerId != null} onClose={onClose} width={440} label="Customer">
      {/* Keyed on the id, per the house React Compiler rule: a new customer
          is fresh state, not an existing component to reset via an effect —
          remounting is what starts a new fetch and clears the last one's
          answer, including mid-flight. */}
      {customerId ? (
        <QuickViewLoader key={customerId} customerId={customerId} onClose={onClose} />
      ) : null}
    </Drawer>
  );
}

function QuickViewLoader({
  customerId,
  onClose,
}: {
  customerId: string;
  onClose: () => void;
}) {
  const [state, setState] = React.useState<
    | { status: "loading" }
    | { status: "gone" }
    | { status: "ready"; customer: QuickViewCustomer; info: QuickViewInfo | null }
  >({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/sales/customer-quick-view?customerId=${encodeURIComponent(customerId)}`)
      .then((r) => r.json())
      .then((body: { customer: QuickViewCustomer | null; info: QuickViewInfo | null }) => {
        if (cancelled) return;
        if (!body.customer) setState({ status: "gone" });
        else setState({ status: "ready", customer: body.customer, info: body.info });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "gone" });
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  if (state.status === "loading") {
    return (
      <>
        <DrawerHeader onClose={onClose}>
          <div className="text-lg font-semibold text-ink">Loading…</div>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-[13px] text-muted">
          Reading the record.
        </div>
      </>
    );
  }

  if (state.status === "gone") {
    return (
      <>
        <DrawerHeader onClose={onClose}>
          <div className="text-lg font-semibold text-ink">Not available</div>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-[13px] text-muted">
          This account is outside your scope, or no longer exists.
        </div>
      </>
    );
  }

  return <QuickViewBody customer={state.customer} info={state.info} onClose={onClose} />;
}

function QuickViewBody({
  customer: c,
  info,
  onClose,
}: {
  customer: QuickViewCustomer;
  info: QuickViewInfo | null;
  onClose: () => void;
}) {
  const status = customerStatusLabel(c);
  const statusTone =
    status === "Deactivated"
      ? "danger"
      : status === "Inactive"
        ? "warn"
        : status === "Slow payer"
          ? "warn"
          : status === "New"
            ? "neutral"
            : "success";

  return (
    <>
      <DrawerHeader onClose={onClose}>
        <div className="text-lg leading-6 font-semibold text-ink">{c.name}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{accountTypeLabel(c)}</Badge>
          <Badge tone={statusTone}>{status}</Badge>
        </div>
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <Section title="Contact">
          <Row label="Phone" value={phoneDisplay(c.phone)} />
          {c.contactPerson ? <Row label="Contact person" value={c.contactPerson} /> : null}
          {c.whatsappPhone && c.whatsappPhone !== c.phone ? (
            <Row label="WhatsApp" value={phoneDisplay(c.whatsappPhone)} />
          ) : null}
          <Row
            label="Address"
            value={[c.address, c.city, c.region].filter(Boolean).join(", ") || "—"}
          />
          {c.beat ? <Row label="Beat" value={c.beat} /> : null}
        </Section>

        <Section title="Who runs this account">
          {c.kind === "lead" ? (
            <Row label="Owner" value={c.ownerName ?? "—"} />
          ) : (
            <>
              <Row label="Sales" value={c.salesAmName ?? "—"} />
              <Row label="Reports to" value={c.salesManagerName ?? "—"} />
              <Row label="Back office" value={c.backOfficeAmName ?? "—"} />
            </>
          )}
        </Section>

        {c.kind === "customer" ? (
          <Section title="Money">
            <Row
              label="Outstanding"
              value={money(c.outstanding)}
              tone={c.outstanding > 0 ? "warn" : undefined}
            />
            {info?.purchase ? (
              <>
                <Row
                  label="Last order"
                  value={
                    info.purchase.lastOrderDate
                      ? `${shortDate(info.purchase.lastOrderDate)} (${info.purchase.lastOrderDaysAgo} days ago)`
                      : "Never"
                  }
                />
                <Row
                  label="Buying cycle"
                  value={`${info.purchase.cycleDays} days${info.purchase.cycleIsDefault ? " (default — not enough history)" : ""}`}
                />
                {info.purchase.nextOrderDate ? (
                  <Row label="Next order due" value={shortDate(info.purchase.nextOrderDate)} />
                ) : null}
              </>
            ) : null}
          </Section>
        ) : null}

        {c.nextStep && c.nextStep.headline ? (
          <Section title="Next step">
            <div className="flex items-center gap-2">
              <Dot tone={NEXT_STEP_LABELS[c.nextStep.kind].tone} />
              <span className="text-[13px] font-medium text-ink">{c.nextStep.headline}</span>
            </div>
            {c.nextStep.detail ? (
              <p className="mt-1 text-[13px] text-muted">{c.nextStep.detail}</p>
            ) : null}
          </Section>
        ) : null}

        {info?.recentCalls?.length ? (
          <Section title="Recent calls">
            <div className="space-y-2">
              {info.recentCalls.map((call) => (
                <div key={call.id} className="text-[13px]">
                  <div className="text-muted">
                    {shortDate(call.at)}
                    {call.outcome ? ` · ${call.outcome}` : ""}
                  </div>
                  {call.notes ? <div className="text-ink">{call.notes}</div> : null}
                </div>
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className={tone === "warn" ? "font-medium text-warn-ink" : "text-ink"}>{value}</span>
    </div>
  );
}
