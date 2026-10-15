import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpScreenBySlug } from "@/lib/erp/registry";
import { screenModule } from "@/lib/erp/screens";
import { getConfig } from "@/lib/config/store";
import { refValues } from "@/lib/erp/refs";
import { consignments, lrUploadKit, messages, placeOptions, transporters, uploadedLrs } from "@/lib/erp/logistics";
import { today as businessToday } from "@/lib/erp/screens/common";
import { ListScreen, ListTabs } from "../_ui/list-screen";
import { screenTabs } from "../_ui/screen-tabs";
import { Page } from "../_ui/page-head";
import { LrDesk } from "./parts/lr-desk";
import { Messages } from "./parts/messages";
import { OnRoad } from "./parts/on-road";
import { Delivered, Overview } from "./parts/overview";
import { ToTransport } from "./parts/to-transport";
import { Transporters } from "./parts/transporters";
import { UploadLrsButton } from "./parts/upload-lrs-button";

/**
 * THE LOGISTICS DESK — the whole road from the factory gate to the party's
 * door, one tab per step:
 *
 *   Today            the pipeline, the calls owed and what needs attention
 *   To transporter   dispatched bills on their way to the transporter's godown
 *   LR desk          LRs the dispatch team uploaded, attached to their bills
 *   On the road      one card per LR: ring, update, report a problem, deliver
 *   Delivered        closed, with how long it took
 *   Customer messages every WhatsApp the flow wrote, and those to send by hand
 *   Transporters     who to ring, and their tracking page
 *   All bills / Paid freight   the registers, as lists
 *
 * The rules are `lib/erp/engines/logistics.ts`, the reads and writes
 * `lib/erp/logistics.ts`. Holding the Transport screen opens every tab.
 */
export const dynamic = "force-dynamic";

const BOARD = new Set(["transport", "toTransport", "pendingLr", "trackLr", "delivered", "lrMessages", "transporters"]);

export default async function LogisticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("transport")) redirect("/erp");
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const screen = erpScreenBySlug("transport")!;
  const views = screen.views ?? [];
  const known = new Set(views.map((v) => v.key));
  const view = one("view") && known.has(one("view")!) ? one("view")! : "transport";
  const { tabs, at } = await screenTabs(ctx, screen, view);
  const canWrite = !ctx.viewingAs;

  /* The two registers are ordinary lists, drawn as every other ERP list is. */
  if (!BOARD.has(view)) {
    const mod = screenModule(view);
    if (!mod) notFound();
    const { spec, rows } = await mod.load(ctx);
    const f = one("f");
    return (
      <ListScreen
        key={`${view}|${f ?? ""}`}
        initialNew={null}
        spec={spec}
        rows={rows}
        label={screen.label}
        sub={screen.sub}
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
  const [all, lrs, outbox, dir, kit] = await Promise.all([
    consignments(),
    view === "pendingLr" || view === "transport" ? uploadedLrs() : Promise.resolve([]),
    view === "lrMessages" || view === "transport" ? messages({ limit: view === "transport" ? 500 : 300 }) : Promise.resolve([]),
    view === "transporters" || view === "pendingLr" ? transporters() : Promise.resolve([]),
    canWrite ? lrUploadKit() : Promise.resolve(null),
  ]);
  const [tree, labels] = view === "transporters" ? await Promise.all([placeOptions(), refValues("consignmentLabel")]) : [[], []];
  /* A dashboard tile opens a tab narrowed to the bills it counted. */
  const ids = one("f")?.split(",");
  const rows = ids ? all.filter((c) => ids.includes(c.id)) : all;
  const waitingMessages = outbox.filter((m) => m.status === "to_send" || m.status === "failed").length;
  const filter = one("filter");

  return (
    <Page
      title={screen.label}
      sub={screen.sub}
      actions={
        kit ? <UploadLrsButton key={one("upload") ?? ""} today={today} transporters={kit.transporters} recent={kit.recent} canRead={kit.canRead} initialOpen={one("upload") === "1"} /> : null
      }
    >
      <ListTabs label={screen.label} tabs={tabs} />
      {ids ? (
        <div className="mb-3 flex items-center gap-2 text-meta text-muted">
          Showing {ids.length} bill{ids.length === 1 ? "" : "s"}: {one("fl") ?? "filtered"} · <Link href={at(view)}>Show everything</Link>
        </div>
      ) : null}

      {view === "transport" ? <Overview rows={rows} lrsWaiting={lrs.length} messagesWaiting={waitingMessages} today={today} lateAfterDays={cfg["erp.logistics.lateAfterDays"]} /> : null}
      {view === "toTransport" ? <ToTransport rows={rows.filter((c) => c.phase === "toTransport")} today={today} canWrite={canWrite} /> : null}
      {view === "pendingLr" ? (
        <LrDesk
          lrs={lrs}
          waiting={rows.filter((c) => c.phase === "lrPending")}
          onTheWay={rows.filter((c) => c.phase === "toTransport")}
          today={today}
          transporters={dir.filter((t) => t.active).map((t) => t.name)}
          callEveryDays={cfg["erp.logistics.callEveryDays"]}
          notifyOn={cfg["erp.logistics.notifyCustomers"]}
          canWrite={canWrite}
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
          initialFilter={filter === "calls" || filter === "late" || filter === "issue" ? filter : undefined}
        />
      ) : null}
      {view === "delivered" ? <Delivered rows={rows.filter((c) => c.phase === "delivered")} canWrite={canWrite} /> : null}
      {view === "lrMessages" ? <Messages rows={outbox} canWrite={canWrite} wati={cfg["erp.logistics.watiTemplate"].trim() || null} /> : null}
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
