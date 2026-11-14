import { NavLink } from "@/components/shell/nav-link";
import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpHref, erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { getConfig } from "@/lib/config/store";
import { refValues } from "@/lib/erp/refs";
import { consignments, lrUploadKit, messages, placeOptions, routeSuggestions, transporters, uploadedLrs } from "@/lib/erp/logistics";
import { today as businessToday } from "@/lib/erp/screens/common";
import { syncDispatchedTransports } from "@/lib/erp/screens/sales";
import { ListScreen, ListTabs } from "../_ui/list-screen";
import { lightPage, lightRow, lightSpec } from "@/lib/erp/lazy-forms";
import { pageOf, parseListQuery } from "@/lib/erp/list-query";
import { withReadMemo } from "@/lib/erp/read-memo";
import { scopeFor, windowInfo } from "@/lib/erp/window";
import { FLAG } from "@/lib/erp/ui";
import { screenTabs } from "../_ui/screen-tabs";
import { Page } from "../_ui/page-head";
import { linkClass } from "../_ui/look";
import { DocumentsDesk } from "./parts/documents-desk";
import { nowMs } from "@/lib/format";
import { Messages } from "./parts/messages";
import { OnRoad } from "./parts/on-road";
import { Delivered, Overview } from "./parts/overview";
import { ToTransport } from "./parts/to-transport";
import { Transporters } from "./parts/transporters";
import { FreightDesk, type FreightSub } from "./parts/freight";
import { FREIGHT_TRIP_DAYS, freightBills, freightReport, recentVehicles, waitingBills } from "@/lib/erp/freight-bills";
import { isErpManager } from "@/lib/erp/screens/common";
import { addDays } from "@/lib/erp/engines/logistics";
import { UploadLrsButton } from "./parts/upload-lrs-button";

/**
 * THE LOGISTICS DESK — the whole road from the factory gate to the party's
 * door, one tab per step:
 *
 *   Today            the pipeline, the calls owed and what needs attention
 *   To transporter   dispatched bills on their way to the transporter's godown
 *   Documents desk   LRs and signed copies uploaded from the phone, checked and attached
 *   On the road      one card per LR: ring, update, report a problem, deliver
 *   Delivered        closed, with how long it took
 *   Customer messages every WhatsApp the flow wrote, and those to send by hand
 *   Transport expenses  transporters' bills, split over each order line by litres;
 *                    Pending expense and Paid history (lib/erp/freight-bills.ts)
 *   Transporters     who to ring, and their tracking page
 *   All bills        the register, as a list
 *
 * The rules are `lib/erp/engines/logistics.ts`, the reads and writes
 * `lib/erp/logistics.ts`. Holding the Transport screen opens every tab.
 */
export const dynamic = "force-dynamic";

const BOARD = new Set(["transport", "toTransport", "pendingLr", "trackLr", "delivered", "lrMessages", "freight", "transporters"]);
/* Trips & freight and Paid freight became Transport expenses. */
const RETIRED_VIEWS = new Set(["trips", "paidFreight"]);

export default async function LogisticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("transport")) redirect("/erp");
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const screen = erpScreenBySlug("transport")!;
  const views = screen.views ?? [];
  const known = new Set(views.map((v) => v.key));
  if (RETIRED_VIEWS.has(one("view") ?? "")) redirect(`${erpScreenHref()}?view=freight`);
  const view = one("view") && known.has(one("view")!) ? one("view")! : "transport";
  const { tabs, at } = await screenTabs(ctx, screen, view);
  const canWrite = !ctx.viewingAs;

  /* The two registers are ordinary lists, drawn as every other ERP list is. */
  if (!BOARD.has(view)) {
    const mod = screenModule(view);
    if (!mod) notFound();
    const f = one("f");
    /* One page travels, as on every other ERP list (`[slug]/page.tsx`), read through the register's window. */
    const query = parseListQuery(raw);
    const open = one("open");
    const scope = { ...scopeFor(mod.window, query, open ?? null), forms: "defer" as const };
    const { spec, rows, tooWide } = await withReadMemo(() => mod.load(ctx, scope));
    const page = lightPage(mod, { ...pageOf(spec, rows, query, FLAG), ...(mod.window ? { window: windowInfo(mod.window, scope, tooWide ?? null) } : {}) });
    const found = open ? (rows.find((r) => r.id === open) ?? null) : null;
    return (
      <ListScreen
        key={`${view}|${f ?? ""}|${open ?? ""}`}
        initialNew={null}
        spec={lightSpec(spec)}
        rows={page.rows}
        server={{ ...page, query }}
        openRow={found ? lightRow(mod, found) : null}
        label={screen.label}
        tabs={tabs}
        toggle={null}
        initialOpen={one("open") ?? null}
        filter={f ? { label: one("fl") ?? "Filtered", ids: f.split(",") } : null}
        godowns={ctx.assignedGodowns.map((g) => ({ v: g.name, l: g.name }))}
      />
    );
  }

  const today = businessToday();
  const cfg = await getConfig();
  /* Anything dispatch-verified that is on no consignment is handed over before the board is read. */
  await syncDispatchedTransports(ctx.actor.id, cfg["erp.logistics.syncDays"]).catch(() => 0);
  const [all, lrs, outbox, dir, kit] = await Promise.all([
    consignments(),
    /* The desk compares each copy with the ones attached lately, so it reads those too. */
    view === "pendingLr" ? uploadedLrs({ status: "all", recentDays: 120 }) : view === "transport" ? uploadedLrs() : view === "trackLr" ? uploadedLrs({ kind: "signed_copy" }) : Promise.resolve([]),
    view === "lrMessages" || view === "transport" ? messages({ limit: view === "transport" ? 500 : 300 }) : Promise.resolve([]),
    view === "transporters" || view === "pendingLr" || view === "freight" || view === "trackLr" ? transporters() : Promise.resolve([]),
    canWrite ? lrUploadKit() : Promise.resolve(null),
  ]);
  const [tree, labels] = view === "transporters" ? await Promise.all([placeOptions(), refValues("consignmentLabel")]) : [[], []];
  const freight = view === "freight" ? await freightData(one, today) : null;
  const suggestions = view === "trackLr" ? await routeSuggestions() : null;
  /* A dashboard tile opens a tab narrowed to the bills it counted. */
  const ids = one("f")?.split(",");
  const rows = ids ? all.filter((c) => ids.includes(c.id)) : all;
  const waitingMessages = outbox.filter((m) => m.status === "to_send" || m.status === "failed").length;
  const filter = one("filter");

  return (
    <Page
      title={screen.label}
      actions={
        kit ? <UploadLrsButton key={one("upload") ?? ""} today={today} transporters={kit.transporters} recent={kit.recent} canRead={kit.canRead} initialOpen={one("upload") === "1"} /> : null
      }
    >
      <ListTabs label={screen.label} tabs={tabs} />
      {ids ? (
        <div className="mb-3 flex items-center gap-2 text-meta text-muted">
          Showing {ids.length} bill{ids.length === 1 ? "" : "s"}: {one("fl") ?? "filtered"} · <NavLink href={at(view)} className={linkClass()}>
            Show everything
          </NavLink>
        </div>
      ) : null}

      {view === "transport" ? <Overview rows={rows} lrsWaiting={lrs.filter((l) => l.status === "unassigned").length} messagesWaiting={waitingMessages} today={today} lateAfterDays={cfg["erp.logistics.lateAfterDays"]} /> : null}
      {view === "toTransport" ? <ToTransport rows={rows.filter((c) => c.phase === "toTransport")} today={today} canWrite={canWrite} /> : null}
      {view === "pendingLr" ? (
        <DocumentsDesk
          copies={lrs}
          waiting={rows.filter((c) => c.phase === "lrPending")}
          onTheWay={rows.filter((c) => c.phase === "toTransport")}
          ownOnRoad={rows.filter((c) => c.ownVehicle && c.phase === "onRoad")}
          transporterOnRoad={rows.filter((c) => !c.ownVehicle && c.phase === "onRoad")}
          today={today}
          nowMs={nowMs()}
          transporters={dir.filter((t) => t.active).map((t) => t.name)}
          callEveryDays={cfg["erp.logistics.callEveryDays"]}
          notifyOn={cfg["erp.logistics.notifyCustomers"]}
          canWrite={canWrite}
          canRead={kit?.canRead ?? false}
          stuckLrDays={cfg["erp.ai.alerts.stuckLrDays"]}
          initialKind={one("kind") === "signed_copy" ? "signed_copy" : one("kind") === "pending" ? "pending" : "lr"}
        />
      ) : null}
      {view === "trackLr" ? (
        <OnRoad
          rows={rows.filter((c) => c.phase === "onRoad")}
          today={today}
          callEveryDays={cfg["erp.logistics.callEveryDays"]}
          lateAfterDays={cfg["erp.logistics.lateAfterDays"]}
          notifyOn={cfg["erp.logistics.notifyCustomers"]}
          canWrite={canWrite}
          suggestions={suggestions}
          initialFilter={filter === "calls" || filter === "late" || filter === "issue" ? filter : undefined}
          signedWaiting={lrs}
          transporters={dir.filter((t) => t.active).map((t) => t.name)}
        />
      ) : null}
      {view === "delivered" ? <Delivered rows={rows.filter((c) => c.phase === "delivered")} canWrite={canWrite} /> : null}
      {view === "lrMessages" ? <Messages rows={outbox} canWrite={canWrite} wati={cfg["erp.logistics.watiTemplate"].trim() || null} /> : null}
      {freight ? (
        <FreightDesk
          key={`${freight.sub}|${freight.month}|${freight.from}|${freight.to}|${one("bill") ?? ""}|${one("add") ?? ""}`}
          {...freight}
          base={at("freight")}
          transporters={dir.filter((t) => t.active).map((t) => t.name)}
          today={today}
          canWrite={canWrite}
          manager={isErpManager(ctx)}
          initialOpen={one("bill") ?? null}
          initialAdd={one("add") === "1"}
        />
      ) : null}
      {view === "transporters" ? (
        <Transporters
          rows={dir}
          tree={tree}
          labels={labels}
          canWrite={canWrite}
          load={Object.fromEntries(
            dir.map((t) => {
              const mine = all.filter((c) => c.phase !== "delivered" && (c.transporter ?? "").toLowerCase() === t.name.toLowerCase());
              return [t.name.toLowerCase(), { active: mine.length, road: mine.filter((c) => c.phase === "onRoad").length }];
            }),
          )}
        />
      ) : null}
    </Page>
  );
}

/** The address of the Logistics screen, for the redirect of a retired tab. */
function erpScreenHref(): string {
  return erpHref(erpScreenBySlug("transport")!);
}

/**
 * TRANSPORT EXPENSES' reads: the sub-tab (`ft`), the bills it lists, the
 * vehicles the add form offers, and the figures above the list.
 */
async function freightData(one: (k: string) => string | undefined, today: string) {
  const ft = one("ft");
  const sub: FreightSub = ft === "paid" || ft === "reports" ? ft : "pending";
  const monthRaw = one("month");
  const month = monthRaw && /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : today.slice(0, 7);
  const monthEnd = addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1);
  const from = one("from") ?? addDays(today, -365);
  const to = one("to") ?? today;
  const [pendingBills, paidBills, report, vehicles, waiting] = await Promise.all([
    freightBills({ status: "pending" }),
    sub === "paid" ? freightBills({ status: "paid", from: `${month}-01`, to: monthEnd }) : Promise.resolve([]),
    sub === "reports" ? freightReport(from, to) : Promise.resolve(null),
    recentVehicles(FREIGHT_TRIP_DAYS),
    waitingBills(FREIGHT_TRIP_DAYS),
  ]);
  /* A bill opened from a link may be outside the list on screen — read it on its own. */
  const opened = one("bill");
  const shown = sub === "paid" ? paidBills : pendingBills;
  const extra = opened && !shown.some((b) => b.id === opened) ? await freightBills({ status: "pending", ids: [opened] }) : [];
  return {
    sub,
    month,
    from,
    to,
    bills: shown,
    openedBill: extra[0] ?? null,
    report,
    vehicles,
    waiting,
    pendingCount: pendingBills.length,
    pendingPaise: pendingBills.reduce((a, b) => a + b.amountPaise, 0),
    tripDays: FREIGHT_TRIP_DAYS,
  };
}
