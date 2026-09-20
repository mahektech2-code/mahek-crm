/* ---------------------------------------------------------------------------
 * §8.3 — WHAT THE FUNNEL SCREEN DRAWS, WORKED OUT ONCE.
 *
 * The specification asks for two pictures and they are two pictures because
 * they are two different jobs. Direct and third-party leads climb what is, rung
 * for rung, the same sale — a shop is found, qualified, given a sample, argued
 * with about price and eventually buys — so the honest drawing is ONE funnel
 * they are both measured in, with each rung split by which of the two it is.
 * Distributor appointment is not a longer version of that sale: its rungs are
 * APPROVALS, and a bar chart of approvals invites the reader to look for the
 * drop-off between two steps that nobody ever intended to be a conversion.
 *
 * PURE, like every engine here. It takes the counts and performs no I/O, which
 * is what lets the rule below — which rungs are drawn and which are not — be
 * pinned by a test rather than by opening a screen and counting bars.
 *
 * IT DOES NOT RESTATE A LADDER. `DIRECT_LADDER`, `THIRD_PARTY_LADDER` and
 * `DISTRIBUTOR_LADDER` come from `lead-ladder.ts` and are the ordering; the one
 * list this file writes out is the two operational stages below, which is a
 * statement about the FUNNEL VIEW rather than about any ladder.
 * ------------------------------------------------------------------------- */

import {
  DIRECT_LADDER,
  DISTRIBUTOR_LADDER,
  THIRD_PARTY_LADDER,
} from "./lead-ladder";
import type { LeadSalesType, LeadStage } from "../lead-labels";

/**
 * THE TWO RUNGS THE FUNNEL LEAVES OUT, AND IT IS NOT AN OMISSION.
 *
 * `delivery` and `payment` are rungs on both shop ladders and a lead genuinely
 * stands on them — they are not dead values and nothing here pretends
 * otherwise. What they are not is SALES PROGRESS. Where a lorry has got to and
 * whether accounts have seen the money are operational states of an order that
 * has already been won; drawn as segments of a funnel they read as two more
 * places a sale can fall out of, and a manager looking for the rung his book
 * gets stuck on would be handed the position of a lorry as an answer.
 *
 * The next person to read this screen will think they were forgotten, which is
 * why they are COUNTED AND SHOWN rather than filtered away — see
 * `SharedFunnel.operational`. A funnel whose bars do not add up to its own
 * total is a funnel nobody trusts twice, and the fix for that is to say where
 * the difference went, not to fold it back in.
 */
export const OPERATIONAL_STAGES: readonly LeadStage[] = ["delivery", "payment"] as const;

/** The two tracks the shared funnel measures, in the order §3 lists them. */
export const SHARED_TRACKS: readonly LeadSalesType[] = ["direct", "third_party"] as const;

/**
 * One rung of one ladder, as the funnel service counts it.
 *
 * Declared structurally rather than imported from `lead-funnel-service.ts`,
 * which is `server-only`: an engine that imports a service is an engine that
 * cannot be tested without a database, and the whole point of this file is
 * that it can.
 */
export type RungTally = {
  stage: LeadStage;
  count: number;
  medianDaysHere: number | null;
  dated: number;
  potentialPaise: number;
};

export type LadderTally = {
  salesType: LeadSalesType | null;
  rungs: readonly RungTally[];
  offLadder: readonly RungTally[];
  inFunnel: number;
  parked: number;
  lost: number;
  arrived: number;
  arrivedByStage: Partial<Record<LeadStage, number>>;
};

/* ═══════════════════════════════════════════ the shared bar funnel (§8.3a) */

/**
 * One track's share of one rung.
 *
 * `carried` is the half that has to be said out loud. `sample_received` is on
 * the direct ladder and not on the third-party one — §3C drops it, because the
 * sample goes through the distributor and the date we could stand behind is
 * when it was reviewed rather than when it landed — so a third-party segment
 * of zero on that row means "no such rung", not "nobody is standing here". The
 * two look identical as a number and are opposite answers to whether anything
 * is wrong.
 */
export type TrackSegment = {
  salesType: LeadSalesType;
  count: number;
  carried: boolean;
  medianDaysHere: number | null;
  dated: number;
};

export type SharedRung = {
  stage: LeadStage;
  /** The two tracks added. Counts add; medians do not, which is why they sit
      on the segments and never on the row. */
  total: number;
  potentialPaise: number;
  segments: TrackSegment[];
};

export type SharedFunnel = {
  /** In direct-ladder order, operational rungs removed. Ten of them. */
  rungs: SharedRung[];
  /** `delivery` and `payment`, counted, so the screen can say where they went. */
  operational: SharedRung[];
  /** The fullest rung, which is what every bar is measured against. */
  widest: number;
  parked: number;
  lost: number;
  /** Rows on a rung neither shop ladder carries — usually a changed sales type. */
  offLadder: RungTally[];
};

/**
 * The rungs the shared funnel draws, which is the UNION of the two shop
 * ladders minus the operational pair.
 *
 * Union rather than intersection, and that is the one decision in this file
 * worth arguing about. The intersection would drop `sample_received` — a rung
 * a third of this book stands on — because one of the two ladders does not
 * carry it, which is a funnel that hides its own commonest stall to keep two
 * columns the same length. The union draws it and marks the third-party
 * segment as a rung that does not exist, which is the true thing.
 *
 * `DIRECT_LADDER` supplies the ORDER because it is the superset; the assertion
 * below is what stops that being a coincidence somebody relies on.
 */
export function sharedRungOrder(): LeadStage[] {
  const order = DIRECT_LADDER.filter((s) => !OPERATIONAL_STAGES.includes(s));

  /*
   * FAIL LOUDLY RATHER THAN DROP ONE. There are twenty-three rungs across three
   * ladders and a screen that quietly omits one draws a funnel that shrinks as
   * the team works it — the worst possible direction for this particular bug,
   * and the reason `bandOf` exists one file over. If somebody ever gives the
   * third-party ladder a rung the direct one has not got, this throws on the
   * next render instead of that rung's leads vanishing off the screen.
   */
  const missing = THIRD_PARTY_LADDER.filter(
    (s) => !DIRECT_LADDER.includes(s) && !OPERATIONAL_STAGES.includes(s),
  );
  if (missing.length > 0) {
    throw new Error(
      `lead-funnel-shape: the third-party ladder carries ${missing.join(", ")}, which the ` +
        `direct ladder does not — the shared funnel is ordered by the direct ladder and ` +
        `would drop them. Order the union explicitly instead.`,
    );
  }

  return order;
}

/**
 * Direct and third-party, measured in one funnel.
 *
 * A track with no leads at all is still a segment: a book that has never raised
 * a third-party lead should read as a track at zero rather than as a funnel
 * that quietly became a one-track chart.
 */
export function sharedFunnel(ladders: readonly LadderTally[]): SharedFunnel {
  const tracks = SHARED_TRACKS.map((t) => ({
    salesType: t,
    ladder: t === "direct" ? DIRECT_LADDER : THIRD_PARTY_LADDER,
    tally: ladders.find((l) => l.salesType === t) ?? null,
  }));

  const cellFor = (
    tally: LadderTally | null,
    stage: LeadStage,
  ): RungTally | null => {
    if (!tally) return null;
    const onLadder = tally.rungs.find((r) => r.stage === stage);
    if (!onLadder) return null;
    /*
     * The top rung's count is NOT in `rungs`. `funnelByRung` files `customer`
     * under `arrived`, because a converted lead has left the funnel — which is
     * right for the four headline figures and wrong for a ladder that has to
     * put a number on its own last rung. `arrivedByStage` is what says which,
     * and reading `arrived` instead would quietly count legacy `won` leads onto
     * a rung they were never on.
     */
    const arrived = tally.arrivedByStage[stage];
    if (arrived === undefined) return onLadder;
    return { ...onLadder, count: onLadder.count + arrived };
  };

  const build = (stage: LeadStage): SharedRung => {
    const segments: TrackSegment[] = tracks.map((t) => {
      const carried = t.ladder.includes(stage);
      const cell = carried ? cellFor(t.tally, stage) : null;
      return {
        salesType: t.salesType,
        carried,
        count: cell?.count ?? 0,
        medianDaysHere: cell?.medianDaysHere ?? null,
        dated: cell?.dated ?? 0,
      };
    });
    return {
      stage,
      total: segments.reduce((n, s) => n + s.count, 0),
      potentialPaise: tracks.reduce(
        (n, t) => n + (cellFor(t.tally, stage)?.potentialPaise ?? 0),
        0,
      ),
      segments,
    };
  };

  const rungs = sharedRungOrder().map(build);
  const operational = OPERATIONAL_STAGES.map(build);

  return {
    rungs,
    operational,
    widest: rungs.reduce((n, r) => Math.max(n, r.total), 0),
    parked: tracks.reduce((n, t) => n + (t.tally?.parked ?? 0), 0),
    lost: tracks.reduce((n, t) => n + (t.tally?.lost ?? 0), 0),
    offLadder: tracks.flatMap((t) => [...(t.tally?.offLadder ?? [])]),
  };
}

/* ═════════════════════════════════════════ the distributor ladder (§8.3b) */

export type LadderStep = {
  stage: LeadStage;
  count: number;
  medianDaysHere: number | null;
  dated: number;
  potentialPaise: number;
  /** Whether this step is one of §12's two approvals rather than a conversation. */
  approval: boolean;
};

export type StepLadder = {
  steps: LadderStep[];
  parked: number;
  lost: number;
  offLadder: RungTally[];
  /** Everybody still climbing it. What decides whether the screen says anything. */
  climbing: number;
};

/**
 * THE TWO STEPS THAT ARE DECISIONS RATHER THAN CONVERSATIONS.
 *
 * §12 says a salesman may never appoint a distributor and a manager may not do
 * it alone, which is why `management_review` and `distributor_approval` are
 * both on the ladder at all. Drawn identically to the steps around them they
 * read as two more stages somebody works through; marked, they read as what
 * they are — the two places the lead is waiting on somebody else entirely, and
 * therefore the two places a long median is a queue rather than a slow salesman.
 */
const APPROVAL_STEPS: readonly LeadStage[] = [
  "management_review",
  "distributor_approval",
] as const;

/**
 * The distributor track as a ladder of steps.
 *
 * Every rung is drawn, including the empty ones, and including the two below
 * `management_review` that it shares with the shop ladders — a ladder that
 * begins half way up is one a reader cannot place. The specification names six
 * steps because those six are what is PARTICULAR to an appointment; the climb
 * to them is still a suspect being qualified.
 */
export function distributorLadder(ladders: readonly LadderTally[]): StepLadder {
  const tally = ladders.find((l) => l.salesType === "distributor") ?? null;

  const steps: LadderStep[] = DISTRIBUTOR_LADDER.map((stage) => {
    const cell = tally?.rungs.find((r) => r.stage === stage) ?? null;
    /* `active_distributor` is the top of this ladder and has arrived, so its
       count is in `arrivedByStage` for the same reason `customer` is. */
    const arrived = tally?.arrivedByStage[stage] ?? 0;
    return {
      stage,
      count: (cell?.count ?? 0) + arrived,
      medianDaysHere: cell?.medianDaysHere ?? null,
      dated: cell?.dated ?? 0,
      potentialPaise: cell?.potentialPaise ?? 0,
      approval: APPROVAL_STEPS.includes(stage),
    };
  });

  return {
    steps,
    parked: tally?.parked ?? 0,
    lost: tally?.lost ?? 0,
    offLadder: [...(tally?.offLadder ?? [])],
    climbing: steps.reduce((n, s) => n + s.count, 0),
  };
}

/* ═══════════════════════════════════════════════════════ the legacy six */

/**
 * The ladders neither picture covers.
 *
 * §8.3 names two visualisations and there are FOUR populations: the two shop
 * tracks, the distributor one, and the leads raised before any of this existed,
 * which carry no sales type and climb the original six rungs. Nothing backfills
 * a sales type — guessing which of three ladders somebody was on is a decision
 * dressed up as a migration — so those leads are real, they are still climbing,
 * and a screen drawing only what the specification named would leave them off
 * every picture on it.
 */
export function unpicturedLadders<T extends LadderTally>(ladders: readonly T[]): T[] {
  const covered = new Set<LeadSalesType | null>([...SHARED_TRACKS, "distributor"]);
  return ladders.filter((l) => !covered.has(l.salesType));
}
