"use client";

import * as React from "react";
import { Button, Checkbox, Field, Input, MoneyInput, Select, Textarea, cx } from "@/components/ui/primitives";
import { Modal, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { createDirectCustomer } from "@/lib/actions/customer-create";
import { INDIA_STATES } from "@/lib/india-states";
import { NEW_CUSTOMER_TAB, newCustomerSchema, seatFromPick, type NewCustomerInput } from "@/lib/new-customer";

/* ---------------------------------------------------------------------------
 * ADD CUSTOMER — the Accounts desk opening an account we invoice.
 *
 * The same five tabs the edit form has, in the same order, so somebody who has
 * corrected a record knows where everything is on a new one. What differs is
 * only what a new record needs: the mobile is asked directly (the contacts list
 * is built from it on save), the state is a fixed list rather than free text
 * (it is what a salesman's territory matches on), and the account managers are
 * a first answer rather than a move, so no reason is asked.
 *
 * The rules are `newCustomerSchema` — the server's own — run here before the
 * request goes, so a missing field is shown on its tab rather than as a toast.
 * The server runs them again regardless.
 * ------------------------------------------------------------------------- */

type Person = { id: string; name: string };
type TabKey = "details" | "address" | "commercial" | "managers";

const EMPTY = {
  name: "",
  contactPerson: "",
  phone: "",
  whatsappPhone: "",
  email: "",
  customerType: "",
  externalCode: "",
  address: "",
  city: "",
  state: "",
  area: "",
  route: "",
  gstin: "",
  creditTermDays: "30",
  creditLimit: "",
  priceTag: "",
  freightTerm: "",
  deliveryType: "",
  sales: "",
  backOffice: "",
  salesManager: "",
};
type Values = typeof EMPTY;

function without(errors: Record<string, string>, key: string): Record<string, string> {
  const next = { ...errors };
  delete next[key];
  return next;
}

function paiseOf(rupees: string): number | null {
  const v = rupees.replace(/[,\s₹]/g, "");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function toInput(v: Values, allowSameName: boolean): NewCustomerInput {
  return {
    name: v.name,
    contactPerson: v.contactPerson,
    phone: v.phone.replace(/\D/g, "").slice(-10),
    whatsappPhone: v.whatsappPhone.replace(/\D/g, "").slice(-10),
    email: v.email,
    customerType: v.customerType as NewCustomerInput["customerType"],
    externalCode: v.externalCode,
    address: v.address,
    city: v.city,
    state: v.state,
    area: v.area,
    route: v.route,
    gstin: v.gstin,
    creditTermDays: v.creditTermDays === "" ? 30 : Number(v.creditTermDays),
    creditLimitPaise: paiseOf(v.creditLimit),
    priceTag: v.priceTag,
    freightTerm: v.freightTerm as NewCustomerInput["freightTerm"],
    deliveryType: v.deliveryType,
    sales: seatFromPick(v.sales),
    backOffice: seatFromPick(v.backOffice),
    salesManager: seatFromPick(v.salesManager),
    allowSameName,
  };
}

export function AddCustomerDialog(props: {
  open: boolean;
  onClose: () => void;
  onAdded: (customer: { id: string; name: string }) => void;
  /** Accounts and current employees — the list the edit form's seats offer. */
  people: Person[];
  salesManagerPeople: Person[];
  salesManagerSuggestions: Record<string, string>;
  canAssignSalesManager: boolean;
  canDecideCredit: boolean;
}) {
  if (!props.open) return null;
  // Mounted fresh on every open, so a half-filled form never leaks into the next one.
  return <AddCustomerBody {...props} />;
}

function AddCustomerBody({
  onClose,
  onAdded,
  people,
  salesManagerPeople,
  salesManagerSuggestions,
  canAssignSalesManager,
  canDecideCredit,
}: React.ComponentProps<typeof AddCustomerDialog>) {
  const { run } = useToast();
  const [tab, setTab] = React.useState<TabKey>("details");
  const [values, setValues] = React.useState<Values>(EMPTY);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [sameNameWarning, setSameNameWarning] = React.useState<string | null>(null);
  const [allowSameName, setAllowSameName] = React.useState(false);
  const [salesManagerTouched, setSalesManagerTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setValues((v) => ({ ...v, [k]: value }));
    if (errors[k]) setErrors((e) => without(e, k));
    if (k === "name") {
      setSameNameWarning(null);
      setAllowSameName(false);
    }
  };

  /** Errors per tab, so a tab carrying a problem says so in its label. */
  const tabHasError = (key: TabKey) =>
    Object.keys(errors).some((f) => (NEW_CUSTOMER_TAB[f] ?? "details") === key);
  const label = (key: TabKey, text: string) => (tabHasError(key) ? `${text} •` : text);

  function showErrors(list: { field: string; message: string }[]) {
    const next: Record<string, string> = {};
    for (const e of list) if (!next[e.field]) next[e.field] = e.message;
    setErrors(next);
    const first = list[0];
    if (first) setTab(NEW_CUSTOMER_TAB[first.field] ?? "details");
  }

  async function save() {
    const input = toInput(values, allowSameName);
    const checked = newCustomerSchema.safeParse(input);
    if (!checked.success) {
      showErrors(checked.error.issues.map((i) => ({ field: String(i.path[0] ?? ""), message: i.message })));
      return;
    }
    if (values.creditLimit && !canDecideCredit) {
      showErrors([{ field: "creditLimitPaise", message: "Set by whoever confirms payments in Accounts." }]);
      return;
    }
    setBusy(true);
    try {
      const result = await run(createDirectCustomer(input));
      if (result.ok) {
        onAdded(result.data);
        return;
      }
      const fields = result.fieldErrors ?? [];
      if (fields.some((f) => f.field === "allowSameName")) {
        setSameNameWarning(result.error);
        setTab("details");
      }
      showErrors(fields.filter((f) => f.field !== "allowSameName"));
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors[f] ?? null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Add customer"
      width={780}
      footer={
        <>
          <span className="mr-auto self-center text-[12px] text-muted">
            Fields marked required must be filled. Everything else can be added later from Edit.
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {busy ? "Adding…" : "Add customer"}
          </Button>
        </>
      }
    >
      <Tabs
        className="-mx-5 -mt-4 mb-4 px-3"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "details", label: label("details", "Details") },
          { key: "address", label: label("address", "Address & area") },
          { key: "commercial", label: label("commercial", "Commercial") },
          { key: "managers", label: label("managers", "Account managers") },
        ]}
      />

      <div className="min-h-[420px]">
        {tab === "details" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Business name · required"
              hint="Exactly as it appears on the bill — the order sheet matches on it."
              error={err("name")}
              className="col-span-2"
            >
              <Input value={values.name} onChange={set("name")} placeholder="As it appears on the bill" autoFocus />
            </Field>
            {sameNameWarning ? (
              <div className="col-span-2 rounded-[4px] border border-warn-line bg-warn-soft px-3 py-2 text-[13px] text-warn-ink">
                <p>{sameNameWarning}</p>
                <div className="mt-1.5">
                  <Checkbox
                    label="It is a different shop — add it anyway"
                    checked={allowSameName}
                    onChange={(e) => setAllowSameName(e.target.checked)}
                  />
                </div>
              </div>
            ) : null}
            <Field label="Contact person" hint="Who we speak to.">
              <Input value={values.contactPerson} onChange={set("contactPerson")} />
            </Field>
            <Field label="Mobile · required" hint="The number we ring." error={err("phone")}>
              <Input
                value={values.phone}
                onChange={set("phone")}
                inputMode="numeric"
                placeholder="10 digits"
                maxLength={14}
              />
            </Field>
            <Field
              label="WhatsApp number"
              hint="Only if different from the mobile."
              error={err("whatsappPhone")}
            >
              <Input
                value={values.whatsappPhone}
                onChange={set("whatsappPhone")}
                inputMode="numeric"
                placeholder="Same as mobile"
                maxLength={14}
              />
            </Field>
            <Field label="Email" hint="For statements and invoices." error={err("email")}>
              <Input type="email" value={values.email} onChange={set("email")} />
            </Field>
            <Field label="Type of business">
              <Select value={values.customerType} onChange={set("customerType")}>
                <option value="">Not stated</option>
                <option value="dealer">Dealer</option>
                <option value="retailer">Retailer</option>
                <option value="distributor">Distributor</option>
                <option value="manufacturer">Manufacturer</option>
              </Select>
            </Field>
            <Field label="Customer code" hint="The code in Tally or on the sheet." error={err("externalCode")}>
              <Input value={values.externalCode} onChange={set("externalCode")} />
            </Field>
          </div>
        ) : null}

        {tab === "address" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Address" className="col-span-2">
              <Textarea rows={2} value={values.address} onChange={set("address")} />
            </Field>
            <Field label="City · required" error={err("city")}>
              <Input value={values.city} onChange={set("city")} />
            </Field>
            <Field
              label="State · required"
              hint="Decides which salesmen's handsets carry this shop."
              error={err("state")}
            >
              <Select value={values.state} onChange={set("state")}>
                <option value="">Pick a state</option>
                {INDIA_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Area">
              <Input value={values.area} onChange={set("area")} />
            </Field>
            <Field label="Route">
              <Input value={values.route} onChange={set("route")} />
            </Field>
            <p className="col-span-2 text-[12px] text-muted">
              The city and state place the shop on the location tree as soon as it is saved.
            </p>
          </div>
        ) : null}

        {tab === "commercial" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="GSTIN" hint="Checked against its own check digit." error={err("gstin")}>
              <Input
                value={values.gstin}
                onChange={set("gstin")}
                maxLength={15}
                className="uppercase"
                placeholder="15 characters"
              />
            </Field>
            <Field label="Credit terms (days)" error={err("creditTermDays")}>
              <Input type="number" min={0} max={180} value={values.creditTermDays} onChange={set("creditTermDays")} />
            </Field>
            <Field
              label="Credit limit (₹)"
              hint={canDecideCredit ? "Blank means no limit." : "Set by whoever confirms payments in Accounts."}
              error={err("creditLimitPaise")}
            >
              <MoneyInput value={values.creditLimit} onChange={set("creditLimit")} disabled={!canDecideCredit} />
            </Field>
            <Field label="Price list tag" hint="Which price list applies.">
              <Input value={values.priceTag} onChange={set("priceTag")} />
            </Field>
            <Field label="Freight">
              <Select value={values.freightTerm} onChange={set("freightTerm")}>
                <option value="">Not stated</option>
                <option value="paid">Paid — built into the price</option>
                <option value="to_pay">To pay — the shop pays on delivery</option>
              </Select>
            </Field>
            <Field label="Delivery">
              <Select value={values.deliveryType} onChange={set("deliveryType")}>
                <option value="">Not stated</option>
                <option value="Door Delivery">Door delivery</option>
                <option value="Godown Delivery">Godown delivery</option>
              </Select>
            </Field>
          </div>
        ) : null}

        {tab === "managers" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Account manager · sales · required"
              hint="Whose book this account is in — their Call Log, collections and target."
              error={err("sales")}
            >
              <Select
                value={values.sales}
                onChange={(e) => {
                  const picked = e.target.value;
                  const suggested = salesManagerSuggestions[picked];
                  setValues((v) => ({
                    ...v,
                    sales: picked,
                    // The org chart's suggestion, only while nobody has answered it.
                    ...(!salesManagerTouched && suggested && canAssignSalesManager
                      ? { salesManager: suggested }
                      : {}),
                  }));
                  if (errors.sales) setErrors((e) => without(e, "sales"));
                }}
              >
                <option value="">Pick somebody</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              {values.sales.startsWith("emp:") ? (
                <span className="mt-1 block text-[12px] text-warn-ink">
                  No MahekOne sign-in: the account is recorded under their name but lands on nobody&apos;s
                  Call Log or handset until they have one.
                </span>
              ) : null}
            </Field>
            <Field
              label="Account manager · back office"
              hint="Dispatch, billing and paperwork."
              error={err("backOffice")}
            >
              <Select value={values.backOffice} onChange={set("backOffice")}>
                <option value="">Unassigned</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Sales manager"
              hint={
                canAssignSalesManager
                  ? "Who the salesperson answers to. Suggested from the org chart."
                  : "Only a manager or admin can set this."
              }
              error={err("salesManager")}
            >
              <Select
                value={values.salesManager}
                disabled={!canAssignSalesManager}
                onChange={(e) => {
                  setSalesManagerTouched(true);
                  set("salesManager")(e);
                }}
              >
                <option value="">Unassigned</option>
                {salesManagerPeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div
              className={cx(
                "col-span-2 rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-[13px] text-body",
              )}
            >
              On save the account appears straight away in Accounts and the CRM, on the sales account
              manager&apos;s Call Log and collections list, and on their handset at its next sync if the
              state and city are inside their territory. The people named here are notified.
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
