import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";
import { moduleForPath } from "@/lib/modules";
import { today } from "@/lib/recompute";
import { sharedFunnel } from "@/lib/engines/lead-funnel-shape";
import { funnelByRung } from "@/lib/services/lead-funnel-service";
import { leadTileCounts } from "@/lib/services/lead-views-service";
import {
  leadsForRole,
  managerLeadBlocks,
  needsAttention,
  readsManagerStrip,
} from "@/lib/services/lead-dashboard-service";
import { vantageViewer } from "@/lib/services/lead-vantage-service";
import { Empty } from "@/components/console/parts";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { DashboardScreen } from "@/components/leads/dashboard/dashboard-screen";

/**
 * §8.2 — the lead dashboard's three answers.
 *
 * The screen is `dashboard-screen.tsx` and what it draws comes out of
 * `lead-dashboard-service.ts`, the leads list's own tile counts and the funnel
 * screen's own read; what lives here is the four things a route has to decide
 * — which business day the day's work is measured from, who the reader is,
 * which of the blocks, tiles and pictures this particular person can actually
 * open, and what to say when there is nothing for them at all.
 *
 * **THE CLOCK IS READ HERE AND NOWHERE ELSE.** Everything below is dated from
 * the working day in Asia/Kolkata rather than from whatever zone the database
 * session happens to be in — `today()` applies the configured boundary and
 * every service takes the answer as a parameter. A client component may not
 * read the clock during render at all, which is the React Compiler rule this
 * codebase runs under, and a `now()` inside a statement would have been the
 * bare-cast bug in its usual clothing.
 *
 * **THE STRIP IS THE TWO VANTAGES THAT RUN A BOOK, which is §8.2's own
 * wording.** It is a statement about other people's work — seven queues across
 * the whole funnel — and a salesman reading it can act on none of it. So it is
 * drawn for the sales manager and for management, asked through
 * `readsManagerStrip`, which resolves the question through `vantagesFor` so
 * there is no second reading of who is who. The other two cards are drawn for
 * everybody, because "what is owed today" and "what is waiting on you" are
 * questions every reader of this screen has.
 *
 * **A TILE THAT OPENS NOTHING IS WORSE THAN AN ABSENT ONE, so everything here
 * is narrowed again to the modules this person holds.** Every block is a door,
 * and five of the seven lead out of All Leads into Qualification, Samples and
 * Commercial — which are separately grantable, and are deliberately withheld
 * from people who do not do that work. Drawn anyway, a withheld block would
 * hand somebody a count off a screen they were refused and then bounce them
 * off `requireModule` when they pressed it, which reads as a broken link
 * rather than as a grant they were never given. It is the same rule the
 * sidebar already follows — it draws only what somebody holds — and this
 * dashboard must not be the one place a narrowed grant is quietly widened.
 * The nine tiles and the funnel card are asked the same question about their
 * own two destinations — All Leads and Funnel & conversion — rather than being
 * drawn unconditionally on the reasoning that a count is harmless. A count is
 * not harmless: it is a door with a number on it.
 *
 * **Nothing at all is a sentence, not a blank page.** It used to be reachable
 * by holding All Leads alone, because the strip was the whole screen; it is
 * now rarer still — a reader with no blocks, no All Leads, no funnel, nothing
 * owed anywhere in their book and no job on any lead. Holding All Leads is by
 * itself enough for this screen to have something on it, which is why the two
 * new reads join the condition rather than sitting outside it. An empty grid with a heading over it
 * reads as a screen that failed to load, so it says which it is.
 *
 * The guard is `dashboard/layout.tsx`, which holds `<workspace>.leads`.
 * Nothing in here re-checks it: one gate per route, in the layout the route
 * sits under.
 */
export async function Body({ workspace }: { workspace: LeadWorkspace }) {
  const user = await requireUser();

  const [day, held, viewer] = await Promise.all([
    today(),
    listUserModules(user.id, workspace),
    vantageViewer(user),
  ]);

  /* The three reads together. None of them is this file's own query — see the
     service — and running them in one `Promise.all` is what keeps a screen
     made of three other screens' answers costing one round of work. */
  const [attention, focus, blocks] = await Promise.all([
    needsAttention(day),
    leadsForRole(day, viewer),
    readsManagerStrip(viewer) ? managerLeadBlocks(day) : Promise.resolve([]),
  ]);

  const keys = new Set(held.map((m) => m.key));

  /* THE SAME RULE THE BLOCKS ARE NARROWED BY, asked about two more doors.
     The nine tiles all open All Leads and the funnel card opens Funnel &
     conversion, both separately grantable — so both are resolved against the
     registry rather than matched on a prefix, because the registry is what a
     grant points at and what the route guard enforces. Drawn to somebody who
     holds neither, they would be nine counts and ten bars off screens they are
     refused, which reads as a broken link rather than as a grant they were
     never given. */
  const holds = (path: string) => {
    const mod = moduleForPath(leadHref(workspace, path));
    return !mod || keys.has(mod.key);
  };

  const open = blocks.filter((b) => {
    /* Resolved against the registry rather than matched on a prefix: the
       registry is what a grant points at and what the route guard enforces, so
       asking it is the only way this screen and that guard cannot disagree
       about one href. A block whose destination is registered nowhere is drawn
       — it is a screen nobody can be refused, so there is nothing to withhold. */
    const mod = moduleForPath(leadHref(workspace, b.href));
    return !mod || keys.has(mod.key);
  });

  /*
   * The two reads behind the strip and the picture, asked only where the
   * reader can open what they lead to.
   *
   * NEITHER IS A READING OF ITS OWN. `leadTileCounts` is the same function the
   * leads list runs above its own table, asked with no filters because a
   * dashboard stands in none; `funnelByRung` is the single read the funnel
   * screen makes, shaped by the same pure engine. A dashboard figure computed
   * from scratch is cheap to write and expensive to be wrong about — the
   * reader presses it, lands on a list of a different length, and stops
   * believing every other figure on the screen at the same time.
   */
  const [tiles, ladders] = await Promise.all([
    holds("leads") ? leadTileCounts(day) : Promise.resolve(null),
    holds("leads/funnel") ? funnelByRung(day) : Promise.resolve(null),
  ]);

  const nothing =
    tiles === null &&
    ladders === null &&
    open.length === 0 &&
    attention.rows.length === 0 &&
    attention.overdueTotal === 0 &&
    attention.dueTodayTotal === 0 &&
    focus.total === 0;

  return (
    <>
      <LeadTabs workspace={workspace} />
      {nothing ? (
        <Empty
          title="Nothing on this dashboard for you"
          body="Nothing is owed on a lead today, no lead in your book is waiting on you, and none of the queues across the funnel has been granted to you. Ask a manager for the ones you work in."
        />
      ) : (
        <DashboardScreen
          workspace={workspace}
          blocks={open}
          attention={attention}
          focus={focus}
          tiles={tiles}
          pipeline={ladders ? sharedFunnel(ladders) : null}
        />
      )}
    </>
  );
}
