"use client";

import { useState } from "react";
import { ComboBox } from "@/components/ui/combo-box";
import { Button, checkboxClass, cx, Input, SectionLabel, Textarea } from "@/components/ui/primitives";
import { calendarDate } from "@/lib/business-date";
import { erpLogisticsUpdate } from "@/lib/actions/erp-logistics";
import { addDays, customerStageWords, MAHEK_VEHICLE, MAX_CITIES_PER_UPDATE, ROAD_STAGES, routeSentence, shortDay, STAGE_SHORT, type Stage } from "@/lib/erp/engines/logistics";
import type { Consignment, RouteSuggestions } from "@/lib/erp/logistics";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { Icon } from "../../_ui/icons";
import { insetClass, linkClass } from "../../_ui/look";
import { CallLink, driverPhone, lrLabel, plural, useAct } from "./common";

/* ---------------------------------------------------------------------------
 * UPDATE AN LR — what somebody fills in with the transporter on the phone.
 *
 * Read top to bottom it is the call itself: where the goods have been (the
 * journey so far, with where they are going), what is new (one choice, laid
 * out in the order a lorry actually travels), the few facts THAT choice needs
 * and nothing else, when to ring again, and — before saving — exactly what
 * the customer will be told. Every fact appears once: the godown and the
 * destination live in the journey, not in a second field below it.
 * ------------------------------------------------------------------------- */

type Choice = "dispatched" | Stage;

/** The way a lorry travels, in order. The last mile is two cards: it goes one way or the other. */
const ROAD: { key: Choice; label: string; words: string }[] = [
  { key: "dispatched", label: "Left the godown", words: "The transporter has sent it on from its godown or booking office." },
  { key: "In Transit", label: "On the way", words: "Moving. Add every city the transporter mentions — each shows on the customer's tracking page." },
  { key: "On the way to Destination area", label: STAGE_SHORT["On the way to Destination area"], words: "Nearly there — in the destination's district." },
  { key: "Reached Destination Area", label: STAGE_SHORT["Reached Destination Area"], words: "At the transporter's office in the destination city." },
];
const LAST_MILE: { key: Choice; label: string; words: string; icon: "truck" | "home" }[] = [
  { key: "Out for Delivery", label: "Out for delivery", words: "On the local vehicle to the party's door.", icon: "truck" },
  { key: "Ready for Pickup", label: "Ready for pickup", words: "Waiting at the transporter's office for the party to collect.", icon: "home" },
];
const ORDER: Choice[] = ["dispatched", "In Transit", "On the way to Destination area", "Reached Destination Area", "Out for Delivery"];

type CityRow = { key: number; city: string; on: string };

export function UpdateLrDialog({ group, today, callEveryDays, notifyOn, suggestions, onClose }: { group: Consignment[]; today: string; callEveryDays: number; notifyOn: boolean; suggestions: RouteSuggestions | null; onClose: () => void }) {
  const { run, pending } = useAct();
  const c = group[0];
  const ids = group.map((b) => b.id);
  const transit = c.stage === "In Transit" || c.stage === "On the way to Destination area";
  /* Our own vehicle: no transporter's godown to leave from and no office to collect from — the driver takes it to the door. */
  const own = c.ownVehicle;
  const road = own ? ROAD.filter((o) => o.key !== "dispatched") : ROAD;
  const lastMile = own ? LAST_MILE.filter((o) => o.key !== "Ready for Pickup") : LAST_MILE;
  const talkingTo = own ? "driver" : "transporter";

  const [choice, setChoice] = useState<Choice>(ROAD_STAGES.includes(c.stage as Stage) ? (c.stage as Stage) : "In Transit");
  const stage: Stage = choice === "dispatched" ? "In Transit" : choice;
  const [from, setFrom] = useState(c.dispatchedFrom ?? "");
  const [cities, setCities] = useState<CityRow[]>(() => (transit ? [{ key: 1, city: "", on: today }] : []));
  const [destination, setDestination] = useState(c.destination ?? "");
  const [editingDestination, setEditingDestination] = useState(!c.destination);
  const [pickupPoint, setPickupPoint] = useState(c.pickupPoint ?? "");
  const [pickupContact, setPickupContact] = useState(c.pickupContact ?? "");
  const [expected, setExpected] = useState(c.expectedDeliveryOn ?? "");
  const [nextCall, setNextCall] = useState(addDays(today, callEveryDays));
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);

  const filled = cities.filter((r) => r.city.trim());
  const fromChanged = from.trim() !== (c.dispatchedFrom ?? "");
  const destinationChanged = destination.trim() !== (c.destination ?? "");
  const pickupChanged = stage === "Ready for Pickup" && (pickupPoint.trim() !== (c.pickupPoint ?? "") || pickupContact.trim() !== (c.pickupContact ?? ""));
  const moved = stage !== c.stage || !!(expected && expected !== c.expectedDeliveryOn) || filled.length > 0 || (choice === "dispatched" && fromChanged) || pickupChanged;
  const missing =
    choice === "dispatched" && !from.trim()
      ? "Say which godown it left from."
      : stage === "Ready for Pickup" && !pickupPoint.trim()
        ? "Say where the party collects it."
        : cities.some((r) => r.city.trim() && !r.on)
          ? "Give each city the day it was reached."
          : null;

  const addCity = () => setCities((rs) => [...rs, { key: (rs.at(-1)?.key ?? 0) + 1, city: "", on: rs.at(-1)?.on || today }]);
  const setCity = (key: number, patch: Partial<CityRow>) => setCities((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const pick = (k: Choice) => {
    setChoice(k);
    if ((k === "In Transit" || k === "On the way to Destination area") && !cities.length) addCity();
  };

  const theirs = suggestions?.godownsByTransporter[(c.transporter ?? "").toLowerCase()] ?? [];
  const usedBefore = (suggestions?.cities ?? []).map((value) => ({ value }));
  const godownGroups = [
    { label: `${c.transporter ?? "The transporter"}'s godowns`, options: theirs },
    { label: "Mahek godowns", options: suggestions?.ourGodowns ?? [] },
    { label: "Places used before", options: usedBefore },
  ];
  const cityGroups = [{ label: "Places used before", options: usedBefore }];

  /* What this update adds to the journey, drawn in it before saving — nothing is saved that the screen does not show. */
  const added = [...(fromChanged && from.trim() ? [{ key: "from", label: `From ${from.trim()}`, on: null as string | null }] : []), ...filled.slice().sort((a, b) => a.on.localeCompare(b.on)).map((r) => ({ key: `c${r.key}`, label: r.city.trim(), on: r.on as string | null }))];
  /* What the customer is told — the sentence the WhatsApp leads with, built by the same words the server uses. */
  const last = filled.slice().sort((a, b) => a.on.localeCompare(b.on)).at(-1);
  const preview = [
    `Your consignment ${customerStageWords(stage, c.transporter, c.vehicleNo)}.`,
    routeSentence({ stage, dispatchedFrom: from.trim() || null, city: last?.city.trim() ?? c.currentCity, cityOn: last?.on ?? null, destination: destination.trim() || c.lrDestination }),
    stage === "Ready for Pickup" && pickupPoint.trim() ? `Collect it from: ${pickupPoint.trim()}${pickupContact.trim() ? ` (${pickupContact.trim()})` : ""}.` : null,
    expected && stage !== "Ready for Pickup" ? `Expected delivery: ${shortDay(expected)}.` : null,
  ].filter(Boolean);

  const save = () =>
    run(
      () =>
        erpLogisticsUpdate(ids, {
          stage,
          note,
          expectedOn: expected || null,
          nextCallOn: nextCall || null,
          notify,
          ...(choice === "dispatched" || fromChanged ? { dispatchedFrom: from } : {}),
          cities: filled.map((r) => ({ city: r.city, on: r.on })),
          ...(destinationChanged ? { destination } : {}),
          ...(stage === "Ready for Pickup" ? { pickupPoint, pickupContact } : {}),
        }),
      (r) => r.ok && onClose(),
    );

  const reached = ORDER.indexOf(c.stage === "Ready for Pickup" ? "Out for Delivery" : (c.stage as Choice));
  const words = [...ROAD, ...LAST_MILE].find((o) => o.key === choice)?.words;
  const title = `Update ${own ? (c.vehicleNo ?? MAHEK_VEHICLE) : lrLabel(c.lrNo)}`;

  return (
    <ErpDialog onClose={onClose} label={title} size="md" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-body">
          <span>
            <span className="font-medium text-ink">{[...new Set(group.map((b) => b.deliveryParty))].join(", ")}</span> · {plural(group.length, "bill")} · {own ? [c.vehicleNo ?? MAHEK_VEHICLE, c.driver].filter(Boolean).join(" · ") : (c.transporter ?? "No transporter")}
          </span>
          {own ? <CallLink phone={driverPhone(c.driver)} name={c.driver ?? "Driver"} /> : <CallLink phone={c.transporterPhone} name={c.transporter} />}
        </div>

        {/* THE JOURNEY SO FAR — the one place the godown, the cities and the destination are shown. */}
        <section className={cx("bg-canvas", insetClass)} aria-label="Journey so far">
          <SectionLabel className="mb-1.5 block">Journey so far</SectionLabel>
          <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-meta">
            {c.route.length ? (
              c.route.map((r, i) => (
                <li key={`${r.at}${r.city}`} className="flex items-center gap-1.5">
                  {i ? <span className="text-muted" aria-hidden>→</span> : null}
                  <span className={cx("rounded-control border px-1.5 py-0.5", i === c.route.length - 1 ? "border-brand/40 bg-brand-soft font-medium text-ink" : "border-line bg-surface text-body")}>
                    {r.kind === "dispatched" ? "From " : ""}
                    {r.city}
                    <span className="ml-1 text-muted">{shortDay(calendarDate(new Date(r.at))).replace(/^\w+ /, "")}</span>
                  </span>
                </li>
              ))
            ) : added.length ? null : (
              <li className="text-muted">Nothing reported on the way yet.</li>
            )}
            {added.map((a, i) => (
              <li key={a.key} className="flex items-center gap-1.5">
                {i || c.route.length ? <span className="text-muted" aria-hidden>→</span> : null}
                <span className="rounded-control border border-dashed border-brand/60 bg-surface px-1.5 py-0.5 font-medium text-brand-hover" title="Added by this update — saved when you save">
                  {a.label}
                  {a.on ? <span className="ml-1 font-normal text-muted">{shortDay(a.on).replace(/^\w+ /, "")}</span> : null}
                  <span className="ml-1.5 rounded-sm bg-brand-soft px-1 text-2xs font-semibold">new</span>
                </span>
              </li>
            ))}
            {!editingDestination ? (
              <li className="flex items-center gap-1.5">
                <span className="text-muted" aria-hidden>
                  ⋯
                </span>
                <span className="rounded-control border border-dashed border-line px-1.5 py-0.5 text-body">
                  Going to <span className="font-medium text-ink">{destination || "—"}</span>
                </span>
                <button type="button" onClick={() => setEditingDestination(true)} className={linkClass("brand", "text-xs")}>
                  Change
                </button>
              </li>
            ) : null}
          </ol>
          {editingDestination ? (
            <div className="mt-2 flex items-center gap-2">
              <span className="shrink-0 text-meta text-body">Going to</span>
              <ComboBox
                value={destination}
                onChange={setDestination}
                groups={cityGroups}
                label="Destination city"
                placeholder={c.lrDestination ? `As on the LR: ${c.lrDestination}` : "The city of the transporter's delivering office"}
                className="flex-1"
                inputClassName="h-8.5 text-sm"
              />
              {c.destination ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDestination(c.destination ?? "");
                    setEditingDestination(false);
                  }}
                >
                  Keep {c.destination}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* WHAT IS NEW — one choice, in the order the goods travel. */}
        <section aria-label="What is the latest">
          <SectionLabel>What&apos;s the latest?</SectionLabel>
          <div className={cx("mt-1.5 grid gap-1.5", own ? "grid-cols-3" : "grid-cols-4")} role="radiogroup" aria-label="Where the goods are">
            {road.map((o, i) => {
              const on = choice === o.key;
              const past = !on && ORDER.indexOf(o.key) < reached;
              return (
                <button
                  key={o.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick(o.key)}
                  className={cx(
                    "flex cursor-pointer items-center gap-2 rounded-control border px-2 py-2 text-left text-meta",
                    on ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas",
                  )}
                >
                  <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold", on ? "bg-brand text-white" : past ? "bg-success-soft text-success" : "bg-divider text-muted")}>{past ? "✓" : i + 1}</span>
                  <span className="leading-tight">{o.label}</span>
                </button>
              );
            })}
          </div>
          <div className={cx("mt-1.5 grid gap-1.5", own ? "grid-cols-1" : "grid-cols-2")}>
            {lastMile.map((o) => {
              const on = choice === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick(o.key)}
                  className={cx(
                    "flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-left text-meta",
                    on ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas",
                  )}
                >
                  <Icon n={o.icon} s={15} />
                  <span>{o.label}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted">{words}</p>
        </section>

        {/* ONLY WHAT THIS CHOICE NEEDS. */}
        {choice === "dispatched" ? (
          <Labelled label="Which godown or booking office?" hint={theirs.length ? null : `No godowns are saved for ${c.transporter ?? "this transporter"} yet — type the town; add them under Transporters to pick next time.`}>
            <ComboBox value={from} onChange={setFrom} groups={godownGroups} label="Dispatched from" placeholder="Bhiwandi, Vasai, the booking office…" inputClassName="h-8.5 text-sm" className="w-full" />
          </Labelled>
        ) : null}

        {stage === "In Transit" || stage === "On the way to Destination area" ? (
          <section aria-label="Cities reached">
            <SectionLabel>Cities reached since the last call</SectionLabel>
            <div className="mt-1.5 space-y-2">
              {cities.map((r, i) => (
                <div key={r.key} className="flex flex-wrap items-center gap-2">
                  <ComboBox value={r.city} onChange={(v) => setCity(r.key, { city: v })} groups={cityGroups} label={`City ${i + 1}`} placeholder={i ? "Next city" : "City it reached"} className="min-w-[200px] flex-1" inputClassName="h-8.5 text-sm" />
                  <DayChips value={r.on} onChange={(v) => setCity(r.key, { on: v })} today={today} min={c.billDate} options={[{ label: "Today", day: today }, { label: "Yesterday", day: addDays(today, -1) }]} label={`Day it reached city ${i + 1}`} />
                  {cities.length > 1 || r.city ? (
                    <button type="button" onClick={() => setCities((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Remove city ${i + 1}`} className="flex h-8.5 w-8.5 cursor-pointer items-center justify-center rounded-control text-muted hover:bg-canvas hover:text-ink">
                      <Icon n="x" s={14} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {cities.length < MAX_CITIES_PER_UPDATE ? (
              <button type="button" onClick={addCity} className={linkClass("brand", "mt-2 inline-flex items-center gap-1 text-meta")}>
                <Icon n="plus" s={13} />
                {cities.length ? "Add the next city" : "Add a city it reached"}
              </button>
            ) : null}
          </section>
        ) : null}

        {stage === "Ready for Pickup" ? (
          <div className="grid grid-cols-2 gap-3">
            <Labelled label="Where the party collects it">
              <ComboBox value={pickupPoint} onChange={setPickupPoint} groups={godownGroups} label="Pickup point" placeholder="The transporter's office and area" inputClassName="h-8.5 text-sm" className="w-full" />
            </Labelled>
            <Labelled label="Whom to ask there">
              <Input value={pickupContact} onChange={(e) => setPickupContact(e.target.value)} placeholder="Name and phone — optional" maxLength={120} />
            </Labelled>
          </div>
        ) : null}

        {/* WHEN — the date the customer reads, and the call we owe the transporter. */}
        <div className="grid grid-cols-2 gap-4">
          <Labelled label={stage === "Out for Delivery" ? "Delivering on" : stage === "Ready for Pickup" ? "Collect by (if the office gave a day)" : "Expected delivery"}>
            <DayChips
              value={expected}
              onChange={setExpected}
              today={today}
              min={today}
              options={stage === "Out for Delivery" ? [{ label: "Today", day: today }, { label: "Tomorrow", day: addDays(today, 1) }] : [{ label: "Tomorrow", day: addDays(today, 1) }, { label: "In 2 days", day: addDays(today, 2) }, { label: "In 4 days", day: addDays(today, 4) }]}
              label="Expected delivery"
              allowNone
            />
          </Labelled>
          <Labelled label={`Next call to the ${talkingTo}`}>
            <DayChips value={nextCall} onChange={setNextCall} today={today} min={today} options={[{ label: "Tomorrow", day: addDays(today, 1) }, { label: "In 2 days", day: addDays(today, 2) }, { label: "In 3 days", day: addDays(today, 3) }]} label="Next call" />
          </Labelled>
        </div>

        <Labelled label={`What the ${talkingTo} said`}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Only for us — the customer never sees this." />
        </Labelled>

        {/* WHAT THE CUSTOMER GETS — shown before it is sent, or said plainly that nothing is. */}
        {moved ? (
          <section className={cx("bg-canvas", insetClass)} aria-label="What the customer gets">
            <label className={cx("flex items-center gap-2 text-sm", notifyOn ? "cursor-pointer" : "opacity-60")}>
              <input type="checkbox" checked={notify && notifyOn} disabled={!notifyOn} onChange={(e) => setNotify(e.target.checked)} className={checkboxClass} />
              <span className="font-medium text-ink">Tell the customer on WhatsApp</span>
              {!notifyOn ? <span className="text-meta text-muted">— switched off in ERP settings</span> : null}
            </label>
            {notify && notifyOn ? (
              <div className="mt-2 rounded-control border border-line bg-surface px-3 py-2 text-meta text-body">
                {preview.map((l) => (
                  <div key={l}>{l}</div>
                ))}
                <div className="mt-1 text-xs text-muted">With the tracking link. Sent through Wati where it can be; otherwise it waits under Customer messages.</div>
              </div>
            ) : null}
          </section>
        ) : (
          <p className="text-meta text-muted">Nothing new for the customer yet — this is logged as a call.</p>
        )}
      </DialogBody>
      <DialogFooter>
        {missing ? <span className="mr-auto text-meta text-warn-ink">{missing}</span> : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !!missing} onClick={save}>
          {!moved ? "Log the call" : notify && notifyOn ? "Save and tell the customer" : "Save update"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}

function Labelled({ label, hint, children }: { label: string; hint?: string | null; children: React.ReactNode }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * A day, picked the way people say it — "today", "tomorrow", "in two days" —
 * with any other day one tap further. The chosen day is always said back in
 * words, so a tap is never a guess about which date it meant.
 */
function DayChips({
  value,
  onChange,
  options,
  today,
  min,
  label,
  allowNone,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { label: string; day: string }[];
  today: string;
  min?: string | null;
  label: string;
  allowNone?: boolean;
}) {
  const named = options.find((o) => o.day === value);
  const [other, setOther] = useState(!!value && !named);
  const chip = (on: boolean) => cx("h-8.5 cursor-pointer rounded-control border px-2.5 text-meta whitespace-nowrap", on ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas");
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          aria-pressed={!other && value === o.day}
          onClick={() => {
            setOther(false);
            onChange(allowNone && value === o.day ? "" : o.day);
          }}
          className={chip(!other && value === o.day)}
        >
          {o.label}
        </button>
      ))}
      {other ? (
        <Input type="date" value={value} min={min ?? undefined} max={min === today ? undefined : today} onChange={(e) => onChange(e.target.value)} aria-label={label} className="h-8.5 w-[150px]" />
      ) : (
        <button type="button" onClick={() => setOther(true)} className={chip(false)}>
          {value && !named ? shortDay(value) : "Other day"}
        </button>
      )}
    </div>
  );
}
