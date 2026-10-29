"use client";

import * as React from "react";
import { Button, Checkbox, Input, MoneyInput, Select, Textarea, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import {
  bypassConvertLead,
  loadLeadForBypass,
  searchLeadsForBypass,
  type BypassLead,
  type BypassLeadHit,
} from "@/lib/actions/lead-bypass";
import {
  BYPASS_CONFIRM_WORD,
  BYPASS_STEP_OF,
  bypassSchema,
  type BypassInput,
  type BypassStep,
} from "@/lib/lead-bypass";
import { INDIA_STATES } from "@/lib/india-states";
import { cleanWhole, parseRupees } from "@/lib/format";
import { seatFromPick } from "@/lib/new-customer";

/* ---------------------------------------------------------------------------
 * CONVERT A LEAD — the Accounts bypass, in four steps: find the lead, its
 * details, the account and credit, then what is skipped and why.
 *
 * The rules are `bypassSchema` — the server's own — run per step so Next says
 * what is missing on the step you are on. Little text by design: a red * marks
 * a required field, a link icon marks one filled in from the lead.
 * ------------------------------------------------------------------------- */

type Person = { id: string; name: string };
type Values = BypassLead["values"];

const STEPS: { key: BypassStep; label: string; icon: string }[] = [
  { key: "lead", label: "Lead", icon: "search" },
  { key: "details", label: "Details", icon: "doc" },
  { key: "account", label: "Account", icon: "person" },
  { key: "confirm", label: "Confirm", icon: "check" },
];

const TYPES = [
  ["dealer", "Dealer"],
  ["retailer", "Retailer"],
  ["distributor", "Distributor"],
  ["manufacturer", "Manufacturer"],
] as const;

export function BypassConvertDialog(props: {
  open: boolean;
  onClose: () => void;
  onConverted: (customer: { id: string; name: string }) => void;
  people: Person[];
  salesManagerPeople: Person[];
  canAssignSalesManager: boolean;
  canDecideCredit: boolean;
}) {
  if (!props.open) return null;
  // Mounted fresh on every open, so nothing from the last conversion leaks in.
  return <Body {...props} />;
}

function Body({ onClose, onConverted, people, salesManagerPeople, canAssignSalesManager, canDecideCredit }: React.ComponentProps<typeof BypassConvertDialog>) {
  const { run } = useToast();
  const [step, setStep] = React.useState<BypassStep>("lead");
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<BypassLeadHit[] | null>(null);
  const [lead, setLead] = React.useState<BypassLead | null>(null);
  const [values, setValues] = React.useState<Values | null>(null);
  const [gstNotRegistered, setGstNotRegistered] = React.useState(false);
  const [gstReason, setGstReason] = React.useState("");
  const [reasonCode, setReasonCode] = React.useState("");
  const [note, setNote] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<{ id: string; name: string } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = React.useRef(0);

  function search(text: string) {
    setQuery(text);
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < 2) {
      setHits(null);
      return;
    }
    timer.current = setTimeout(async () => {
      const ticket = ++asked.current;
      const result = await searchLeadsForBypass(text);
      if (ticket === asked.current) setHits(result.ok ? result.data : []);
    }, 250);
  }

  async function pick(id: string) {
    setBusy(true);
    try {
      const result = await run(loadLeadForBypass(id));
      if (!result.ok) return;
      setLead(result.data);
      setValues(result.data.values);
      setGstNotRegistered(false);
      setGstReason("");
      setErrors({});
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    setValues((v) => (v ? { ...v, [k]: value } : v));
    setErrors((errs) => {
      const next = { ...errs };
      delete next[k];
      if (k === "creditLimit") delete next.creditLimitPaise;
      return next;
    });
  };

  function input(): BypassInput | null {
    if (!lead || !values) return null;
    return {
      leadId: lead.id,
      name: values.name,
      contactPerson: values.contactPerson,
      phone: values.phone.replace(/\D/g, "").slice(-10),
      whatsappPhone: values.whatsappPhone.replace(/\D/g, "").slice(-10),
      email: values.email,
      customerType: values.customerType as BypassInput["customerType"],
      gstin: values.gstin,
      gstNotRegistered,
      gstNotRegisteredReason: gstReason,
      address: values.address,
      city: values.city,
      state: values.state,
      sales: seatFromPick(values.sales),
      backOffice: seatFromPick(values.backOffice),
      salesManager: seatFromPick(values.salesManager),
      creditTermDays: (values.creditTermDays === "" ? undefined : Number(values.creditTermDays)) as number,
      creditLimitPaise: parseRupees(values.creditLimit),
      priceTag: values.priceTag,
      freightTerm: values.freightTerm as BypassInput["freightTerm"],
      deliveryType: values.deliveryType as BypassInput["deliveryType"],
      reasonCode,
      note,
      confirm,
    };
  }

  /** The schema's issues for the given steps, as field → message. */
  function issuesFor(steps: BypassStep[]): Record<string, string> {
    const data = input();
    if (!data) return {};
    const checked = bypassSchema.safeParse(data);
    const found: Record<string, string> = {};
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        const field = String(issue.path[0] ?? "");
        if (steps.includes(BYPASS_STEP_OF[field] ?? "confirm") && !found[field]) found[field] = issue.message;
      }
    }
    if (steps.includes("account") && values?.creditLimit && !canDecideCredit) {
      found.creditLimitPaise = "Set by whoever confirms payments.";
    }
    return found;
  }

  function next() {
    if (step === "lead") {
      if (lead) setStep("details");
      return;
    }
    const found = issuesFor([step]);
    setErrors(found);
    if (Object.keys(found).length) return;
    setStep(step === "details" ? "account" : "confirm");
  }

  async function convert() {
    const found = issuesFor(["details", "account", "confirm"]);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      setStep(BYPASS_STEP_OF[first] ?? "confirm");
      return;
    }
    const data = input();
    if (!data) return;
    setBusy(true);
    try {
      const result = await run(bypassConvertLead(data));
      if (result.ok) {
        setDone(result.data);
        return;
      }
      const fields = result.fieldErrors ?? [];
      const map: Record<string, string> = {};
      for (const f of fields) if (!map[f.field]) map[f.field] = f.message;
      setErrors(map);
      if (fields[0]) setStep(BYPASS_STEP_OF[fields[0].field] ?? "confirm");
    } finally {
      setBusy(false);
    }
  }

  const back = () => setStep(step === "confirm" ? "account" : step === "account" ? "details" : "lead");
  const missing = Object.keys(errors).length;

  if (done) {
    return (
      <Modal open onClose={() => onConverted(done)} title="Converted" width={520}>
        <div className="flex flex-col items-center gap-5 py-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-brand text-white">
            <Icon name="check" size={32} strokeWidth={2.4} />
          </span>
          <h2 className="text-[19px] font-semibold text-ink">{done.name} is a customer</h2>
          <div className="grid w-full grid-cols-4 gap-2">
            {[
              ["menu", "Customers"],
              ["phone", "Call Log"],
              ["doc", "Billing"],
              ["bell", "Notified"],
            ].map(([icon, label]) => (
              <span key={label} className="flex flex-col items-center gap-1.5 rounded-[8px] border border-line px-2 py-3 text-[12.5px] text-body">
                <Icon name={icon} size={20} className="text-brand" />
                {label}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDone(null);
                setLead(null);
                setValues(null);
                setReasonCode("");
                setNote("");
                setConfirm("");
                setQuery("");
                setHits(null);
                setStep("lead");
              }}
            >
              Another
            </Button>
            <Button variant="primary" onClick={() => onConverted(done)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const linked = (k: keyof Values) => Boolean(lead && lead.values[k] && values && values[k] === lead.values[k]);
  const err = (f: string) => errors[f] ?? null;

  return (
    <Modal
      open
      onClose={onClose}
      width={step === "confirm" ? 880 : 820}
      title={
        <span className="inline-flex items-center gap-2">
          <BoltIcon className="text-brand" />
          {lead ? lead.name : "Convert a lead"}
        </span>
      }
      footer={
        <>
          {missing && step !== "lead" ? (
            <span className="mr-auto inline-flex items-center gap-1.5 self-center text-[12.5px] text-danger">
              <Icon name="alert" size={15} strokeWidth={2} />
              {missing} missing
            </span>
          ) : (
            <span className="mr-auto" />
          )}
          {step === "lead" ? (
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          ) : (
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
          )}
          {step === "confirm" ? (
            <Button variant="primary" disabled={busy} onClick={convert}>
              <span className="inline-flex items-center gap-1.5">
                <BoltIcon />
                {busy ? "Converting…" : "Convert"}
              </span>
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || (step === "lead" && !lead)} onClick={next}>
              Next
            </Button>
          )}
        </>
      }
    >
      <StepBar step={step} />

      <div className="min-h-[440px]">
        {step === "lead" ? (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 rounded-[6px] border-2 border-brand px-3 py-2">
              <Icon name="search" size={18} className="text-muted" />
              <span className="sr-only">Search leads</span>
              <input
                autoFocus
                value={query}
                onChange={(e) => search(e.target.value)}
                placeholder="Name, mobile, GSTIN, city"
                className="flex-1 border-0 bg-transparent text-[15px] text-ink outline-none"
              />
            </label>
            {hits && hits.length === 0 ? (
              <p className="px-1 text-[13px] text-muted">No open lead matches.</p>
            ) : null}
            {hits && hits.length ? (
              <ul className="overflow-hidden rounded-[8px] border border-line">
                {hits.map((h) => {
                  const on = lead?.id === h.id;
                  return (
                    <li key={h.id} className="border-b border-line last:border-0">
                      <button
                        type="button"
                        onClick={() => pick(h.id)}
                        className={cx(
                          "flex w-full items-center gap-3 px-4 py-3 text-left",
                          on ? "bg-brand-soft shadow-[inset_3px_0_0_var(--color-brand)]" : "hover:bg-canvas",
                        )}
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate text-[14px] font-semibold text-ink">{h.name}</span>
                          <span className="flex flex-wrap gap-3 text-[12px] text-muted">
                            {h.phone ? <Meta icon="phone">{h.phone}</Meta> : null}
                            {h.city ? <Meta icon="pin">{h.city}</Meta> : null}
                            <Meta icon="person">{h.ownerName ?? "Unassigned"}</Meta>
                          </span>
                        </span>
                        {h.stage ? <span className="rounded-full bg-canvas px-2.5 py-0.5 text-[11.5px] text-body">{h.stage}</span> : null}
                        {on ? <Icon name="check" size={18} strokeWidth={2.4} className="text-brand" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : null}

        {step === "details" && values ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Req label="Business name" error={err("name")} linked={linked("name")} className="col-span-2">
              <Input value={values.name} onChange={set("name")} />
            </Req>
            <Req label="Contact person" error={err("contactPerson")} linked={linked("contactPerson")}>
              <Input value={values.contactPerson} onChange={set("contactPerson")} />
            </Req>
            <Req label="Mobile" error={err("phone")} linked={linked("phone")}>
              <Input value={values.phone} onChange={set("phone")} inputMode="numeric" maxLength={14} />
            </Req>
            <Req label="Type of business" error={err("customerType")} linked={linked("customerType")}>
              <Select value={values.customerType} onChange={set("customerType")}>
                <option value="">Select</option>
                {TYPES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </Select>
            </Req>
            <Req label="GSTIN" error={err("gstin") ?? err("gstNotRegisteredReason")} linked={linked("gstin")} required={!gstNotRegistered}>
              <Input
                value={gstNotRegistered ? "" : values.gstin}
                onChange={set("gstin")}
                disabled={gstNotRegistered}
                maxLength={15}
                className="uppercase"
              />
              <div className="mt-1.5 flex flex-col gap-1.5">
                <Checkbox
                  label="Not registered"
                  checked={gstNotRegistered}
                  onChange={(e) => {
                    setGstNotRegistered(e.target.checked);
                    setErrors((x) => {
                      const n = { ...x };
                      delete n.gstin;
                      delete n.gstNotRegisteredReason;
                      return n;
                    });
                  }}
                />
                {gstNotRegistered ? (
                  <Input value={gstReason} onChange={(e) => setGstReason(e.target.value)} placeholder="Why" aria-label="Why there is no GSTIN" />
                ) : null}
              </div>
            </Req>
            <Req label="Billing address" error={err("address")} linked={linked("address")} className="col-span-2">
              <Input value={values.address} onChange={set("address")} />
            </Req>
            <Req label="City" error={err("city")} linked={linked("city")}>
              <Input value={values.city} onChange={set("city")} />
            </Req>
            <Req label="State" error={err("state")} linked={linked("state")}>
              <Select value={values.state} onChange={set("state")}>
                <option value="">Select</option>
                {INDIA_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Req>
            <Req label="WhatsApp" error={err("whatsappPhone")} required={false}>
              <Input value={values.whatsappPhone} onChange={set("whatsappPhone")} inputMode="numeric" maxLength={14} placeholder="Same as mobile" />
            </Req>
            <Req label="Email" error={err("email")} required={false}>
              <Input type="email" value={values.email} onChange={set("email")} />
            </Req>
          </div>
        ) : null}

        {step === "account" && values ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Section icon="people">People</Section>
            <Req label="Sales AM" error={err("sales")} linked={linked("sales")}>
              <Select value={values.sales} onChange={set("sales")}>
                <option value="">Select</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Req>
            <Req label="Sales manager" error={err("salesManager")} linked={linked("salesManager")} required={false}>
              <Select value={values.salesManager} onChange={set("salesManager")} disabled={!canAssignSalesManager}>
                <option value="">—</option>
                {salesManagerPeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Req>
            <Req label="Back office" error={err("backOffice")} linked={linked("backOffice")} required={false}>
              <Select value={values.backOffice} onChange={set("backOffice")}>
                <option value="">—</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Req>
            <span />
            <Section icon="wallet">Commercial</Section>
            <Req label="Credit days" error={err("creditTermDays")} linked={linked("creditTermDays")}>
              <Input
                value={values.creditTermDays}
                inputMode="numeric"
                onChange={(e) => {
                  const days = cleanWhole(e.target.value).replace(".", "");
                  setValues((v) => (v ? { ...v, creditTermDays: days } : v));
                  setErrors((x) => {
                    const n = { ...x };
                    delete n.creditTermDays;
                    return n;
                  });
                }}
              />
            </Req>
            <Req label="Credit limit ₹" error={err("creditLimitPaise")} linked={linked("creditLimit")} required={false}>
              <MoneyInput value={values.creditLimit} onChange={set("creditLimit")} disabled={!canDecideCredit} />
            </Req>
            <Req label="Price list" error={err("priceTag")} linked={linked("priceTag")}>
              <Input value={values.priceTag} onChange={set("priceTag")} list="bypass-price-tags" />
              <datalist id="bypass-price-tags">
                {lead?.priceTags.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Req>
            <Req label="Freight" error={err("freightTerm")} linked={linked("freightTerm")}>
              <Select value={values.freightTerm} onChange={set("freightTerm")}>
                <option value="">Select</option>
                <option value="paid">Paid</option>
                <option value="to_pay">To pay</option>
              </Select>
            </Req>
            <Req label="Delivery" error={err("deliveryType")} linked={linked("deliveryType")}>
              <Select value={values.deliveryType} onChange={set("deliveryType")}>
                <option value="">Select</option>
                <option value="Door Delivery">Door delivery</option>
                <option value="Godown Delivery">Godown delivery</option>
              </Select>
            </Req>
          </div>
        ) : null}

        {step === "confirm" && lead && values ? (
          <div className="flex gap-5">
            <div className="flex flex-[1.15] flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="inline-flex items-center gap-2 text-[13px] font-bold text-warn-ink">
                  <Icon name="warning" size={16} strokeWidth={2} className="text-warn" />
                  Skipping
                </span>
                <div className="flex flex-wrap gap-2">
                  {lead.funnel.passed.map((s) => (
                    <span key={s.stage} className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-1 text-[12.5px] text-brand-deep">
                      <Icon name="check" size={12} strokeWidth={3} />
                      {s.label}
                    </span>
                  ))}
                  {lead.funnel.skipped.map((s) => (
                    <span key={s.stage} className="rounded-full bg-danger-soft px-2.5 py-1 text-[12.5px] text-danger line-through">
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>
              <Req label="Reason" error={err("reasonCode")}>
                <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                  <option value="">Select</option>
                  {lead.reasons.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Req>
              <Req label="Note" error={err("note")}>
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </Req>
              <Req label={`Type ${BYPASS_CONFIRM_WORD}`} error={err("confirm")}>
                <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="tracking-[0.1em]" />
              </Req>
            </div>
            <div className="flex flex-[0.85] flex-col rounded-[10px] border border-line bg-canvas px-4 py-3">
              <Line icon="doc">Direct customer</Line>
              <Line icon="person">
                {values.contactPerson} · {values.phone}
              </Line>
              <Line icon="clipboard">{gstNotRegistered ? "Not GST registered" : values.gstin}</Line>
              <Line icon="pin">
                {values.address}, {values.city}, {values.state}
              </Line>
              <Line icon="people">
                {people.find((p) => p.id === values.sales)?.name ?? "—"}
                {values.salesManager ? ` · ${salesManagerPeople.find((p) => p.id === values.salesManager)?.name ?? ""}` : ""}
              </Line>
              <Line icon="wallet">
                {values.creditTermDays} days{values.creditLimit ? ` · ₹${values.creditLimit}` : ""}
              </Line>
              <Line icon="rupee">{values.priceTag}</Line>
              <Line icon="arrowRight">
                {values.freightTerm === "paid" ? "Paid" : "To pay"} · {values.deliveryType.replace(" Delivery", "")}
              </Line>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function StepBar({ step }: { step: BypassStep }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="-mt-1 mb-5 flex items-center gap-2.5">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 ? <li aria-hidden="true" className="h-px flex-1 bg-line" /> : null}
          <li className={cx("flex items-center gap-2 text-[13px]", i === at ? "font-semibold text-ink" : "text-muted")}>
            <span
              className={cx(
                "flex h-[26px] w-[26px] items-center justify-center rounded-full border",
                i === at ? "border-brand bg-brand text-white" : i < at ? "border-brand-softer bg-brand-soft text-brand-deep" : "border-line-strong",
              )}
            >
              <Icon name={i < at ? "check" : s.icon} size={14} strokeWidth={2.2} />
            </span>
            {s.label}
          </li>
        </React.Fragment>
      ))}
    </ol>
  );
}

/** A field whose required mark sits on the same line as its label. */
function Req({
  label,
  error,
  linked,
  required = true,
  className,
  children,
}: {
  label: string;
  error?: string | null;
  linked?: boolean;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 flex items-center gap-1 text-xs font-medium tracking-label text-muted uppercase">
        <span>{label}</span>
        {required ? <span className="text-danger" aria-label="required">*</span> : null}
        {linked ? (
          <span className="ml-auto text-brand" title="From the lead">
            <LinkIcon />
          </span>
        ) : null}
      </span>
      <span className={cx("block [&>select]:w-full", error && "[&>input]:border-danger [&>select]:border-danger [&>textarea]:border-danger")}>
        {children}
      </span>
      {error ? <span className="mt-1 block text-[12.5px] text-danger">{error}</span> : null}
    </label>
  );
}

function Section({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="col-span-2 inline-flex items-center gap-2 pt-1 text-[12px] font-bold text-brand-deep">
      <Icon name={icon} size={16} strokeWidth={2} />
      {children}
    </span>
  );
}

function Meta({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon name={icon} size={13} strokeWidth={2} />
      {children}
    </span>
  );
}

function Line({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2.5 py-1.5 text-[13px] text-ink">
      <Icon name={icon} size={16} strokeWidth={2} className="shrink-0 text-muted" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M13 3L4 14h7l-1 7 9-11h-7z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
    </svg>
  );
}
