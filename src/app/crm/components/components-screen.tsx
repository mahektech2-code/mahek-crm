"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
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
  Radio,
  SectionLabel,
  Select,
  SlowPayerBadge,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Drawer,
  DrawerHeader,
  FilterPills,
  Modal,
  Tabs,
} from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";

/* ---------------------------------------------------------------------------
 * The design system, rendered.
 *
 * This is the handoff artifact: every component in every state, so a change to
 * a token or a primitive can be checked in one place rather than hunted for
 * across fifteen screens. It renders the same primitives the app uses — a
 * swatch that had drifted from the real component would be worse than none.
 * ------------------------------------------------------------------------- */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg leading-6 font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Spec({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-divider py-3.5 last:border-0">
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-2">{children}</div>
      {note ? <p className="mt-1.5 text-[13px] text-muted">{note}</p> : null}
    </div>
  );
}

/** A colour chip that names the token it is showing. */
function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className={cx("block h-10 rounded-[4px] border border-line", className)} />
      <span className="truncate font-mono text-[11px] text-muted">{name}</span>
    </span>
  );
}

export function ComponentsScreen() {
  const { push } = useToast();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [tab, setTab] = React.useState("all");
  const [filter, setFilter] = React.useState("today");
  const [checked, setChecked] = React.useState(true);
  const [radio, setRadio] = React.useState("yes");
  const [toggle, setToggle] = React.useState(true);

  return (
    <div className="max-w-[1440px] px-6 pt-6 pb-10">
      <PageHeader
        title="Components"
        subtitle="Every component in every state. This page is the handoff artifact."
        actions={
          <Link
            href="/crm/help"
            className="inline-flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Back to Help center
          </Link>
        }
      />

      {/* ------------------------------------------------------------ colour */}
      <Group title="Colour">
        <Card className="px-5 py-1">
          <Spec label="Neutral ramp" note="A number with no state. Reads --n-900.">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
              <Swatch name="--color-ink" className="bg-ink" />
              <Swatch name="--color-body" className="bg-body" />
              <Swatch name="--color-muted" className="bg-muted" />
              <Swatch name="--color-line-strong" className="bg-line-strong" />
              <Swatch name="--color-line" className="bg-line" />
              <Swatch name="--color-divider" className="bg-divider" />
              <Swatch name="--color-canvas" className="bg-canvas" />
              <Swatch name="--color-surface" className="bg-surface" />
            </div>
          </Spec>

          <Spec label="Primary purple · lime · warm amber">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-3">
              <Swatch name="--color-brand" className="bg-brand" />
              <Swatch name="--color-brand-hover" className="bg-brand-hover" />
              <Swatch name="--color-brand-soft" className="bg-brand-soft" />
              <Swatch name="--color-brand-softer" className="bg-brand-softer" />
              <Swatch name="--color-brand-lime" className="bg-brand-lime" />
              <Swatch name="--color-warn" className="bg-warn" />
              <Swatch name="--color-warn-soft" className="bg-warn-soft" />
            </div>
          </Spec>

          <Spec label="Semantic status">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
              <span>
                <Swatch name="--color-success" className="bg-success" />
                <span className="mt-1 block text-[13px] text-muted">
                  Money in, work closed, target met.
                </span>
              </span>
              <span>
                <Swatch name="--color-warn" className="bg-warn" />
                <span className="mt-1 block text-[13px] text-muted">
                  Attention, not yet failure. Slipping.
                </span>
              </span>
              <span>
                <Swatch name="--color-danger" className="bg-danger" />
                <span className="mt-1 block text-[13px] text-muted">
                  Overdue, lost, missed. Act today.
                </span>
              </span>
            </div>
          </Spec>
        </Card>
      </Group>

      {/* -------------------------------------------------------- typography */}
      <Group title="Typography">
        <Card className="px-5 py-1">
          <Spec label="Display 28/34">
            <span className="text-[28px] leading-[34px] font-semibold text-ink">
              Smart call queue
            </span>
          </Spec>
          <Spec label="H1 22/28">
            <span className="text-[22px] leading-7 font-semibold text-ink">
              Needs you today
            </span>
          </Spec>
          <Spec label="H2 18/24">
            <span className="text-lg leading-6 font-semibold text-ink">
              Payment follow-up
            </span>
          </Spec>
          <Spec label="Body 14/20">
            <span className="text-sm leading-5 text-body">
              Promised ₹2,00,000 by 08 Aug. Not received.
            </span>
          </Spec>
          <Spec label="Small 13/18">
            <span className="text-[13px] leading-[18px] text-muted">
              Last order 28 Jul · cycle 21 days
            </span>
          </Spec>
          <Spec label="Metric 32/36">
            <span className="text-[32px] leading-9 font-semibold text-ink">₹14,26,400</span>
          </Spec>
          <Spec
            label="Tabular"
            note="Figures line up column to column, so changing a digit never shifts the row."
          >
            <div className="text-sm text-body">
              <div>₹12,43,405</div>
              <div>₹9,97,812</div>
              <div>₹2,74,878</div>
            </div>
          </Spec>
        </Card>
      </Group>

      {/* ----------------------------------------------------------- buttons */}
      <Group title="Buttons">
        <Card className="px-5 py-1">
          <Spec label="Primary">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Save and next</Button>
              <Button variant="primary" size="sm">
                32px primary
              </Button>
              <Button variant="primary" disabled title="Disabled until an outcome is picked">
                Disabled
              </Button>
            </div>
          </Spec>
          <Spec label="Secondary">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary">Edit customer</Button>
              <Button variant="secondary" size="sm">
                32px secondary
              </Button>
              <Button variant="secondary" disabled title="Not permitted for this role">
                Disabled
              </Button>
            </div>
          </Spec>
          <Spec label="Ghost">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost">Keep active</Button>
              <Button variant="ghost" size="sm">
                Hover
              </Button>
            </div>
          </Spec>
          <Spec
            label="Destructive confirm"
            note="A destructive action always asks, and always says what it will do."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                Delete customer
              </Button>
              <Button variant="danger" size="sm" disabled title="Only a manager can do this">
                🔒 Deactivate account
              </Button>
            </div>
          </Spec>
        </Card>
      </Group>

      {/* ------------------------------------------------------------ inputs */}
      <Group title="Inputs">
        <Card className="px-5 py-1">
          <Spec label="Text — default">
            <Field label="Name" hint="Helper text sits below the field.">
              <Input placeholder="Om Sai Enterprises" />
            </Field>
          </Spec>
          <Spec label="Text — focused">
            <Input className="border-brand" defaultValue="Om Sai Enterprises" />
          </Spec>
          <Spec label="Text — error">
            <Field label="Telephone" error="Enter a 10-digit mobile number.">
              <Input invalid defaultValue="9987" />
            </Field>
          </Spec>
          <Spec label="Currency">
            <MoneyInput defaultValue="2,00,000" />
          </Spec>
          <Spec label="Date">
            <Input type="date" defaultValue="2026-08-08" />
          </Spec>
          <Spec label="Select">
            <Select defaultValue="Operations">
              <option>Operations</option>
              <option>Accounts</option>
              <option>Dispatch</option>
            </Select>
          </Spec>
          <Spec label="Search">
            <Input placeholder="Search customers, bills, phone numbers…" />
          </Spec>
          <Spec label="Disabled" note="Normal control.">
            <Input disabled placeholder="Pick a customer first" />
          </Spec>
          <Spec label="Textarea" note="Long messages get skimmed — try to stay under 700.">
            <Textarea
              className="h-20"
              defaultValue="Confirmed the usual quantity, dispatch this week."
            />
          </Spec>
          <Spec
            label="Reason · required"
            note="A reason is required — it is kept on the customer record."
          >
            <Textarea className="h-16" placeholder="Shop closed permanently" />
          </Spec>
          <Spec label="Checkbox and radio">
            <div className="flex flex-wrap items-center gap-5">
              <Checkbox label="Checkbox default" checked={false} onChange={() => {}} />
              <Checkbox
                label="Checkbox selected"
                checked={checked}
                onChange={() => setChecked((c) => !c)}
              />
              <Radio
                name="demo"
                label="Radio default"
                checked={radio === "no"}
                onChange={() => setRadio("no")}
              />
              <Radio
                name="demo"
                label="Radio selected"
                checked={radio === "yes"}
                onChange={() => setRadio("yes")}
              />
            </div>
          </Spec>
          <Spec label="Toggle">
            <span className="flex items-center gap-2">
              <button
                onClick={() => setToggle((t) => !t)}
                className={cx(
                  "inline-flex h-6 w-11 cursor-pointer items-center rounded-full border px-0.5 transition-colors",
                  toggle
                    ? "justify-end border-brand bg-brand"
                    : "justify-start border-line bg-canvas",
                )}
              >
                <span className="block h-5 w-5 rounded-full bg-surface shadow-sm" />
              </button>
              <span className="text-[13px] text-muted">
                {toggle ? "Toggle on" : "Toggle off"}
              </span>
            </span>
          </Spec>
        </Card>
      </Group>

      {/* ------------------------------------------------------ metric strip */}
      <Group title="Metric strip">
        <MetricStrip
          metrics={[
            { label: "Collected", value: "₹4,18,000", tone: "success" },
            { label: "Missed calls", value: "31", tone: "danger", sub: "Retry after 4 pm" },
            { label: "Overdue balance", value: "₹18,40,000", tone: "danger" },
            { label: "Promises kept", value: "43% of billed" },
            { label: "Orders taken", value: "12", sub: "+2 vs yesterday" },
            { label: "Outstanding", value: "₹12,43,405", tone: "danger" },
          ]}
        />
      </Group>

      {/* ------------------------------------------- badges, dots, progress */}
      <Group title="Badges, dots, progress">
        <Card className="px-5 py-1">
          <Spec label="Badges">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="brand">Order due today</Badge>
              <Badge tone="warn">Reminder due</Badge>
              <Badge tone="danger">Status: Overdue</Badge>
              <Badge tone="success">Paid</Badge>
              <Badge tone="muted">Default</Badge>
              <Badge tone="neutral">Check-in due</Badge>
              <SlowPayerBadge />
            </div>
          </Spec>
          <Spec label="Dots">
            <div className="flex flex-wrap items-center gap-4 text-[13px] text-body">
              <span className="flex items-center gap-1.5">
                <Dot tone="success" /> Success value
              </span>
              <span className="flex items-center gap-1.5">
                <Dot tone="warn" /> Amber value
              </span>
              <span className="flex items-center gap-1.5">
                <Dot tone="danger" /> Danger value
              </span>
              <span className="flex items-center gap-1.5">
                <Dot tone="neutral" /> Neutral value
              </span>
            </div>
          </Spec>
          <Spec label="Progress">
            <div className="flex flex-col gap-2">
              <Progress value={20} />
              <Progress value={68} />
              <Progress value={100} />
            </div>
          </Spec>
        </Card>
      </Group>

      {/* -------------------------------- stat cards and worklist rows */}
      <Group title="Stat cards and worklist rows">
        <div className="mb-3 grid grid-cols-[repeat(auto-fit,minmax(216px,1fr))] gap-4">
          <Card className="p-5">
            <SectionLabel>Calling progress</SectionLabel>
            <div className="mt-2 text-[32px] leading-9 font-semibold text-ink">
              3<span className="text-xl text-muted">/6</span>
            </div>
            <Progress value={50} className="mt-3" />
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="text-[13px] text-muted">3 still to work</span>
              <span className="text-[13px] font-medium text-success">+2 vs yesterday</span>
            </div>
          </Card>
          <Card className="p-5">
            <SectionLabel>Missed calls</SectionLabel>
            <div className="mt-2 text-[32px] leading-9 font-semibold text-danger">31</div>
            <div className="mt-2 text-[13px] text-muted">Retry after 4 pm</div>
            <div className="mt-1 text-[13px] font-medium text-danger">−2 vs yesterday</div>
          </Card>
          <Card className="p-5">
            <SectionLabel>Team target</SectionLabel>
            <div className="mt-2 text-[32px] leading-9 font-semibold text-ink">68%</div>
            <Progress value={68} className="mt-2.5" />
            <div className="mt-2 text-[13px] font-medium text-danger">−11 pts</div>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <div className="flex items-center gap-4 border-b border-divider bg-brand-soft/50 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">Om Sai Enterprises</span>
                <Badge tone="danger">Order overdue 44 days</Badge>
                <SlowPayerBadge />
              </div>
              <div className="mt-0.5 text-[13px] text-muted">
                Selected row state · +91 98191 55207
              </div>
            </div>
            <Button size="sm" variant="primary">
              Call
            </Button>
          </div>
          <div className="flex items-center gap-4 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">Krishna Paint House</div>
              <div className="mt-0.5 text-[13px] text-muted">
                Sanjay Kulkarni · +91 99872 61045 · Last order 11 Jun
              </div>
            </div>
            <span className="text-[13px] text-muted">NEFT · balance ₹74,500</span>
          </div>
        </Card>
      </Group>

      {/* ----------------------------------------------------- table states */}
      <Group title="Table states">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
          <Card className="overflow-hidden">
            <div className="border-b border-divider px-4 py-2.5">
              <SectionLabel>Loading</SectionLabel>
            </div>
            <div className="p-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="mb-2.5 flex items-center gap-3 last:mb-0">
                  <span className="block h-2.5 w-[180px] rounded-[2px] bg-divider" />
                  <span className="block h-2.5 w-[120px] rounded-[2px] bg-divider" />
                  <span className="flex-1" />
                  <span className="block h-2.5 w-[90px] rounded-[2px] bg-divider" />
                </div>
              ))}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-divider px-4 py-2.5">
              <SectionLabel>Empty — no data</SectionLabel>
            </div>
            <EmptyState
              title="No customers yet"
              body="No customers have been added to this book yet."
            />
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-divider px-4 py-2.5">
              <SectionLabel>Empty — filters</SectionLabel>
            </div>
            <EmptyState
              title="Nothing matches"
              body="No customers match these filters."
              action={<Button variant="secondary">Clear all</Button>}
            />
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-divider px-4 py-2.5">
              <SectionLabel>Error</SectionLabel>
            </div>
            <EmptyState
              icon={<Icon name="alert" size={24} className="text-danger" />}
              title="Could not load"
              body="The customer list could not be loaded. Your connection dropped."
              action={<Button variant="secondary">Retry</Button>}
            />
          </Card>
        </div>

        <Card className="mt-3 overflow-hidden">
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Owner</Th>
                  <Th align="right">Outstanding</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                <Tr className="hover:bg-canvas">
                  <Td className="font-medium text-ink">Om Sai Enterprises</Td>
                  <Td>Owner: Priya Sharma</Td>
                  <Td align="right" className="font-medium text-danger">
                    ₹12,43,405
                  </Td>
                  <Td>
                    <Badge tone="danger">9 bills past due</Badge>
                  </Td>
                </Tr>
              </tbody>
            </table>
          </div>
          <div className="border-t border-divider bg-canvas px-4 py-2 text-[13px] text-muted">
            11 customers · last 30 days
          </div>
        </Card>
      </Group>

      {/* ------------------------------ tabs, filter bar, timeline entry */}
      <Group title="Tabs, filter bar, timeline entry">
        <Card className="overflow-hidden">
          <Tabs
            value={tab}
            onChange={setTab}
            className="px-5"
            tabs={[
              { key: "all", label: "All", count: 11 },
              { key: "open", label: "Open", count: 4 },
              { key: "closed", label: "Closed", count: 7 },
            ]}
          />
          <div className="px-5 py-3">
            <FilterPills
              value={filter}
              onChange={setFilter}
              options={[
                { key: "today", label: "Today", count: 6 },
                { key: "week", label: "Last 7 days", count: 24 },
                { key: "month", label: "This month", count: 92 },
              ]}
            />
          </div>
          <div className="border-t border-divider px-5 py-3.5">
            <SectionLabel>Timeline entry</SectionLabel>
            <div className="mt-2 border-l-2 border-brand-softer pl-3">
              <div className="text-[11px] text-muted">02 Aug, 14:00 · Accounts</div>
              <div className="mt-0.5 text-sm text-ink">
                ₹1,10,000 received against bill MM-4301.
              </div>
            </div>
          </div>
        </Card>
      </Group>

      {/* ------------------------------------------- permission treatments */}
      <Group title="Permission treatments">
        <Card className="px-5 py-1">
          <Spec
            label="Available"
            note="Three states, used consistently. A permitted-looking action never fails after the user commits to it."
          >
            <Button variant="secondary">Edit customer</Button>
          </Spec>
          <Spec
            label="Visible but not permitted"
            note="40% opacity, lock, tooltip naming who can do it."
          >
            <Button
              variant="secondary"
              disabled
              title="Only a manager can deactivate an account"
            >
              🔒 Deactivate account
            </Button>
          </Spec>
          <Spec label="Not present" note="Whole modules outside the role's world.">
            <span className="text-[13px] text-muted">nothing renders</span>
          </Spec>
          <Spec label="Read-only">
            <div className="rounded-[4px] border border-line bg-canvas px-3 py-2 text-[13px] text-muted">
              🔒 Read-only — managers write the wording so every telecaller sends the same
              thing.
            </div>
          </Spec>
          <Spec label="Stale data">
            <div className="rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
              Stale data — last synced 12 Aug, 07:30. Figures may be more than 4 hours old.
            </div>
          </Spec>
        </Card>
      </Group>

      {/* ---------------------------------------------------------- overlays */}
      <Group title="Overlays">
        <Card className="p-5">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setModalOpen(true)}>
              Open modal (520px)
            </Button>
            <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
              Open drawer (480px)
            </Button>
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              Open edit form drawer
            </Button>
            <Button variant="secondary" onClick={() => push("Payment recorded")}>
              Show toast with undo
            </Button>
          </div>
        </Card>
      </Group>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Template"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>
              Save customer
            </Button>
          </>
        }
      >
        <Field label="Purpose">
          <Select defaultValue="Payment reminder">
            <option>Payment reminder</option>
            <option>Order confirmation</option>
          </Select>
        </Field>
        <Field label="Message" hint="Long messages get skimmed — try to stay under 700.">
          <Textarea className="h-20" defaultValue="Namaste ji," />
        </Field>
      </Modal>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        label="WhatsApp connection"
      >
        <DrawerHeader onClose={() => setDrawerOpen(false)}>
          <div className="text-lg font-semibold text-ink">WhatsApp connection</div>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto p-5">
          <Field label="Business number" hint="Saves on its own — fix a number without leaving the call">
            <Input defaultValue="+91 98191 55207" />
          </Field>
        </div>
      </Drawer>

      <Drawer open={editOpen} onClose={() => setEditOpen(false)} label="Edit customer">
        <DrawerHeader onClose={() => setEditOpen(false)}>
          <div className="text-lg font-semibold text-ink">Edit customer</div>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto p-5">
          <SectionLabel>Who they are</SectionLabel>
          <Field label="Name" className="mt-2">
            <Input defaultValue="Om Sai Enterprises" />
          </Field>
          <Field label="Telephone" error="Enter a 10-digit mobile number.">
            <Input invalid defaultValue="9987" />
          </Field>
          <SectionLabel>Account</SectionLabel>
          <div className="mt-2 text-sm leading-[22px] text-body">
            GSTIN 27AABCM1234K1Z9
            <br />
            Credit terms 45 days
            <br />
            Customer since Apr 2019
          </div>
        </div>
        <div className="flex gap-2.5 border-t border-line px-5 py-3">
          <Button variant="primary" onClick={() => setEditOpen(false)}>
            Save customer
          </Button>
          <Button variant="secondary" onClick={() => setEditOpen(false)}>
            Cancel
          </Button>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete customer?"
        body="Shop closed permanently. This cannot be undone."
        confirmLabel="Delete customer"
        needsReason
        reasonLabel="Why are you deleting this"
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => push("Customer deleted")}
      />
    </div>
  );
}
