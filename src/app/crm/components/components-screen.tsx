"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dot,
  EmptyState,
  Field,
  Input,
  MetricStrip,
  MoneyInput,
  PageHeader,
  Progress,
  SectionLabel,
  Select,
  SlowPayerBadge,
  Td,
  Textarea,
  Th,
  Tr,
} from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Drawer,
  DrawerHeader,
  FilterPills,
  Modal,
  RowMenu,
  SelectionBar,
  Tabs,
} from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";

/**
 * The design system, rendered from the same components the app uses. If a
 * primitive changes, this page changes with it — there is no second copy.
 */
export function ComponentsScreen() {
  const { push } = useToast();
  const [tab, setTab] = React.useState("one");
  const [pill, setPill] = React.useState("all");
  const [modal, setModal] = React.useState(false);
  const [drawer, setDrawer] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [selection, setSelection] = React.useState(3);

  return (
    <div className="max-w-[1200px] px-6 pt-6 pb-16">
      <PageHeader
        title="Component library"
        subtitle="Every primitive MahekOne is built from. Same code as the app — not a copy."
      />

      <Section title="Colour">
        <div className="grid grid-cols-6 gap-3">
          {[
            ["Canvas", "bg-canvas", "#F7F8FA"],
            ["Surface", "bg-surface", "#FFFFFF"],
            ["Line", "bg-line", "#DDE1E8"],
            ["Ink", "bg-ink", "#161616"],
            ["Body", "bg-body", "#3D4453"],
            ["Muted", "bg-muted", "#6B7385"],
            ["Brand", "bg-brand", "#6835FB"],
            ["Brand hover", "bg-brand-hover", "#5223E0"],
            ["Brand soft", "bg-brand-soft", "#F1ECFF"],
            ["Success", "bg-success", "#1D7A45"],
            ["Warn", "bg-warn", "#B77B08"],
            ["Danger", "bg-danger", "#B3261E"],
          ].map(([name, cls, hex]) => (
            <div key={name}>
              <div
                className={`h-14 rounded-[4px] border border-line ${cls}`}
                aria-hidden
              />
              <div className="mt-1.5 text-[13px] font-medium text-ink">{name}</div>
              <div className="font-mono text-[11px] text-muted">{hex}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography">
        <div className="flex flex-col gap-2">
          <div className="text-[28px] leading-[34px] font-semibold text-ink">
            Page title — 28/34 semibold
          </div>
          <div className="text-lg leading-6 font-semibold text-ink">
            Card title — 18/24 semibold
          </div>
          <div className="text-[15px] text-body">Body large — 15px, used in prose</div>
          <div className="text-sm text-body">Body — 14px, the default</div>
          <div className="text-[13px] text-muted">Secondary — 13px muted</div>
          <SectionLabel>Section label — 12px uppercase, 0.04em</SectionLabel>
          <div className="font-mono text-[13px] text-ink">
            Mono — IBM Plex Mono, used for pasteable text
          </div>
          <div className="text-sm text-ink tabular-nums">
            Numerals are tabular: 1,84,000 · 9,82,400 · 12,00,000
          </div>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" disabled title="Disabled with a reason">
            Disabled
          </Button>
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button variant="secondary" size="sm">
            Small secondary
          </Button>
        </div>
        <p className="mt-3 text-[13px] text-muted">
          A disabled button always carries a title explaining why — never a dead control.
        </p>
      </Section>

      <Section title="Inputs">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
          <Field label="Text">
            <Input placeholder="Shree Paints & Hardware" />
          </Field>
          <Field label="With hint" hint="Ten digits, no country code">
            <Input placeholder="9822014567" />
          </Field>
          <Field label="With error" error="Enter a valid telephone number.">
            <Input defaultValue="98220" invalid />
          </Field>
          <Field label="Money">
            <MoneyInput placeholder="2,00,000" />
          </Field>
          <Field label="Select">
            <Select>
              <option>Delivery</option>
              <option>Billing</option>
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" />
          </Field>
          <Field label="Textarea" className="col-span-2">
            <Textarea className="h-20" placeholder="What was said, what happens next" />
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1">
            <Checkbox label="Slow payers only" defaultChecked />
            <Checkbox label="Customer has been told" />
          </div>
        </div>
      </Section>

      <Section title="Metric strip">
        <MetricStrip
          metrics={[
            { label: "Collectable", value: "₹62,84,000", tone: "danger" },
            { label: "Customers", value: "27" },
            { label: "Promises broken", value: "2", tone: "danger", sub: "call these today" },
            { label: "Connect rate", value: "78%", delta: "+6", deltaTone: "success" },
            { label: "Missed", value: "4", delta: "−2", deltaTone: "success" },
          ]}
        />
      </Section>

      <Section title="Badges, dots and progress">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge tone="neutral">Neutral</Badge>
          <Badge tone="brand">Reminder due</Badge>
          <Badge tone="success">Connected</Badge>
          <Badge tone="warn">Stage 2 sent</Badge>
          <Badge tone="danger">Promise broken</Badge>
          <Badge tone="muted">Default</Badge>
          <SlowPayerBadge />
        </div>
        <div className="mb-4 flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-[13px] text-body">
            <Dot tone="brand" /> Brand
          </span>
          <span className="flex items-center gap-1.5 text-[13px] text-body">
            <Dot tone="success" /> Success
          </span>
          <span className="flex items-center gap-1.5 text-[13px] text-body">
            <Dot tone="warn" /> Warn
          </span>
          <span className="flex items-center gap-1.5 text-[13px] text-body">
            <Dot tone="danger" /> Danger
          </span>
        </div>
        <div className="flex max-w-[420px] flex-col gap-2.5">
          <Progress value={88} tone="success" />
          <Progress value={54} />
          <Progress value={21} tone="danger" />
        </div>
      </Section>

      <Section title="Callouts">
        <Callout tone="warn">
          <span className="text-sm font-medium text-warn-ink">Month-end push</span>
          <span className="text-sm text-body">
            Sorted by collectable value — chase the top of the list first.
          </span>
        </Callout>
        <Callout tone="danger">
          <span className="text-sm text-ink">
            Automatic sending is unavailable. The manual flow is ready, so nothing is
            blocked.
          </span>
        </Callout>
        <Callout tone="brand">
          <span className="text-sm text-ink">
            Six rows carried over from yesterday. The queue rebuilds when you press
            Re-prioritise.
          </span>
        </Callout>
      </Section>

      <Section title="Tabs and filter pills">
        <Tabs
          value={tab}
          onChange={setTab}
          className="mb-4"
          tabs={[
            { key: "one", label: "Open", count: 12 },
            { key: "two", label: "In progress", count: 4 },
            { key: "three", label: "Resolved", count: 31 },
          ]}
        />
        <FilterPills
          value={pill}
          onChange={setPill}
          options={[
            { key: "all", label: "All", count: 27 },
            { key: "slow", label: "Slow payers", count: 9 },
            { key: "over", label: "Over 60 days", count: 5 },
          ]}
        />
      </Section>

      <Section title="Table">
        <Card className="overflow-hidden">
          <table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th align="right">Outstanding</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Shree Paints & Hardware", "Active", "₹1,84,000"],
                ["Om Sai Traders", "Slow payer", "₹96,000"],
                ["Krishna Paint House", "Active", "₹0"],
              ].map(([name, status, amount]) => (
                <Tr key={name} className="hover:bg-canvas">
                  <Td className="font-medium text-ink">{name}</Td>
                  <Td>
                    <Badge tone={status === "Slow payer" ? "warn" : "success"}>
                      {status}
                    </Badge>
                  </Td>
                  <Td align="right" className={amount !== "₹0" ? "text-danger" : ""}>
                    {amount}
                  </Td>
                  <Td align="right">
                    <span className="flex justify-end">
                      <RowMenu
                        items={[
                          { label: "Open record", onSelect: () => push("Opened") },
                          { label: "Send WhatsApp", onSelect: () => push("Sent") },
                          {
                            label: "Request deactivation",
                            destructive: true,
                            onSelect: () => setConfirm(true),
                          },
                        ]}
                      />
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>

      <Section title="Empty state">
        <Card>
          <EmptyState
            title="Queue cleared for today"
            body="Every customer due today has been worked. Suggested next work: the payment follow-up list."
            action={<Button variant="primary">Open payment follow-up</Button>}
          />
        </Card>
      </Section>

      <Section title="Overlays">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setModal(true)}>
            Open modal
          </Button>
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            Open drawer
          </Button>
          <Button variant="secondary" onClick={() => setConfirm(true)}>
            Open confirm with reason
          </Button>
          <Button variant="secondary" onClick={() => push("Reminder set for 14 Aug")}>
            Fire a toast
          </Button>
          <Button
            variant="secondary"
            onClick={() => push("Enter the amount they committed to.", "error")}
          >
            Fire an error toast
          </Button>
          <Button variant="secondary" onClick={() => setSelection(selection ? 0 : 3)}>
            Toggle selection bar
          </Button>
        </div>
      </Section>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Record payment promise"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setModal(false)}>
              Save promise
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          <Field label="Amount promised">
            <MoneyInput placeholder="2,00,000" />
          </Field>
          <Field label="Promised by">
            <Input type="date" />
          </Field>
        </div>
      </Modal>

      <Drawer open={drawer} onClose={() => setDrawer(false)} label="Example drawer">
        <DrawerHeader onClose={() => setDrawer(false)}>
          <div className="text-lg font-semibold text-ink">Shree Paints & Hardware</div>
          <div className="mt-1 text-[13px] text-muted">Mahesh Shah · 98220 14567</div>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto p-5 text-sm text-body">
          Drawers are used where the work has a context that must stay visible — the call
          panel, a complaint, a template.
        </div>
        <div className="border-t border-line px-5 py-3">
          <Button variant="primary" onClick={() => setDrawer(false)}>
            Save and close
          </Button>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirm}
        title="Request deactivation?"
        body="They stay visible until a manager approves it. The reason is kept on the record either way."
        confirmLabel="Request deactivation"
        destructive
        needsReason
        onClose={() => setConfirm(false)}
        onConfirm={(reason) => push(`Requested — ${reason}`)}
      />

      <SelectionBar count={selection} onClear={() => setSelection(0)}>
        <Button variant="dark" size="sm">
          Set reminder
        </Button>
        <Button variant="dark" size="sm">
          Export
        </Button>
      </SelectionBar>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-4 text-lg font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}
