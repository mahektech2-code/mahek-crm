import React from 'react';
import { Animated, View, Pressable, FlatList, RefreshControl, Platform, type ListRenderItemInfo } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { BottomSheet, Calendar } from '../ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../../theme/tokens';
import { ChipRow, PageFooter, SearchBox, ToolButton } from '../ui/book-controls';
import { Icon } from '../ui/Icon';
import {
  createLead,
  leadThresholds,
  leadViewCounts,
  listLeadsPage,
  rungsInBook,
  visitCapThresholds,
  type Lead,
  type LeadBookFilter,
} from '../../data/leads';
import { leadSources } from '../../data/config';
import { territoryState } from '../../sync/pull';
import { areaRule, type AreaChoice, type AreaRule } from '../../engines/lead-areas';
import { takePhoto } from '../../native/capture';
import { LeadScanPanel, useLeadScan, type LeadScanFill } from './lead-scan';
import { AreaField, AreaPickerPage } from './area-picker';
import { rememberPickedArea } from '../../data/lead-areas';
import { LeadVoicePanel, useLeadVoice } from './lead-voice';
import type { LeadVoiceFill } from '../../engines/lead-voice';
import {
  CUSTOMER_TYPES,
  daysBetween,
  leadOwed,
  owedLabel,
  LEAD_VIEWS,
  LEAD_WHENS,
  OTHER_SOURCE,
  leadAlert,
  leadPriorityLabel,
  viewOfLead,
  visitCapLabel,
  visitCapState,
  type DuplicateMatch,
  type LeadSource,
  type LeadThresholds,
  type LeadView,
  type LeadWhen,
  type VisitCapThresholds,
} from '../../engines/leads';
import {
  offeredSalesTypes,
  roleAction,
  salesTypeLabel,
  stageLabel,
  type LeadActionTone,
  type LeadSalesType,
  type LeadStage,
} from '../../engines/funnel';
import { compactInrFromPaise, dmy, grouped, isoDate, pretty } from '../../lib/format';
import { useStore } from '../../state/store';
import { PressableScale, Presence, Stagger, animateLayoutFor, useShake } from '../ui/motion';

/**
 * Leads — shops that are not on the book yet.
 *
 * The list is ordered by what was promised: a follow-up date the salesman gave
 * somebody comes first, and a lead nobody promised anything sits under them
 * rather than off the bottom of the screen. Archived is a filter and never a
 * delete — a shop that said no in March is exactly who somebody wants to find
 * in September.
 *
 * The one thing the form does differently to every other form here is that it
 * checks the number against the customers as well as the leads, and when it
 * finds one it SHOWS the record. A refusal with nothing to open is how the
 * same shop gets typed in twice with a digit changed.
 */

/**
 * The badge's colour, keyed on the CHIP a lead answers to.
 *
 * It was keyed on `leads.stage`, the six-word column, which meant a lead
 * standing on any of the seventeen rungs the funnel added fell through to
 * neutral. The key is `viewOfLead` now, so the badge and the chip that caught
 * the row can never disagree — one lead, one word, one colour.
 */
const VIEW_TONE: Record<LeadView, BadgeTone> = {
  all: 'neutral',
  new: 'info',
  contacted: 'teal',
  qualified: 'amber',
  negotiation: 'amber',
  on_hold: 'neutral',
  converted: 'success',
  lost: 'danger',
  archived: 'neutral',
};

const VIEW_LABEL: Record<LeadView, string> = Object.fromEntries(
  LEAD_VIEWS.map((v) => [v.value, v.label]),
) as Record<LeadView, string>;

/**
 * §7's four tones as ink.
 *
 * `muted` is the one that earns its place — "Nothing operational pending" drawn
 * at the weight of "Payment follow-up" would be read as a task. See
 * `lead-role-action.ts`, which names the four and says why.
 */
const ACTION_INK: Record<LeadActionTone, string> = {
  brand: C.primaryDeep,
  warn: C.warnInk,
  danger: C.danger,
  muted: C.muted,
};

/** A hairline between rows, inset to the text — one list, not a stack of cards. */
function RowGap() {
  return <View style={{ height: 1, marginLeft: 14, backgroundColor: C.hairline }} />;
}

/**
 * ONE LEAD, AND IT LEADS WITH A VERB.
 *
 * The card printed a rung NOUN — "Qualified" — which tells a salesman where the
 * lead stands and not one thing about what he is supposed to do with it this
 * morning. §7 is the specification's answer to that and `roleAction` is the one
 * place it lives: the same function the office reads for him, so the sentence
 * on his phone and the sentence on his manager's screen are the same sentence
 * about the same shop. It is asked from the `salesman` vantage and only that
 * one — his book is his own, and resolving a vantage on a phone would be a
 * second copy of `vantagesFor` deciding which hat somebody is wearing.
 *
 * `sampleAwaitingDispatch` is passed FALSE rather than derived. Nothing in the
 * salesman's own column of §7's table forks on it — it is the back office's
 * fact, read at `sample_trial` to tell them whether to pack a parcel — so
 * deriving it would be a query per row to change no word he reads.
 */
function LeadRow({
  lead,
  today,
  cfg,
  capCfg,
  onPress,
}: {
  lead: Lead;
  today: string;
  cfg: LeadThresholds | null;
  capCfg: VisitCapThresholds | null;
  onPress: (id: string) => void;
}) {
  const view = viewOfLead(lead);
  /*
   * WHAT IS OWED, AND WHICH OF THE THREE DAYS IT IS.
   *
   * The same answer the chips cut by and the same one the sort used — said in
   * words here, which is what pays for the chip being wider than any one
   * column. "Late — you said you would go back on the 14th" and "Late — back
   * off hold since the 14th" are different mornings, and a chip that caught
   * both over a line naming neither would be a count nobody could act on.
   */
  const owed = leadOwed(lead, today);
  const owedLine = owedLabel(owed, pretty);
  const overdue = !!owed && owed.daysLate > 0 && view !== 'converted' && view !== 'lost';

  /*
   * The alert is dropped where the line above has already said it.
   *
   * `leadAlert`'s first branch is the follow-up running late, which is one of
   * the three days `leadOwed` answers about — drawn together they are the same
   * sentence twice, and the narrower one underneath reads as a second, smaller
   * problem. Its other branches are about the lead having gone QUIET, which is
   * a different fact and still worth saying.
   */
  const alert = cfg ? leadAlert(lead, today, cfg) : null;
  const quiet = owed && owed.source === 'promise' && owed.daysLate > 0 ? null : alert;

  const rung = (lead.funnelStage as LeadStage | null) ?? null;
  const facts = {
    stage: (rung ?? 'new') as LeadStage,
    salesType: lead.salesType as LeadSalesType | null,
    hasCommitment: lead.hasCommitment === 1,
    hasOrder: lead.hasOrder === 1,
    sampleAwaitingDispatch: false,
  };
  const action = roleAction(facts, 'salesman');

  /* How long it has sat where it is. `stageSince` is the day it reached this
     rung and is the office's own column, unlike `clientCreatedAt`, which is
     when THIS PHONE first saw the row — see the note on age in the book's own
     header. Said only once it has been a while: "0 days on this rung" on a lead
     somebody moved this morning is a line that costs a row of space to say
     nothing. */
  const held = rung ? daysBetween(lead.stageSince, today) : null;

  /*
   * HOW OLD THE LEAD IS, which this row could not honestly say until now.
   *
   * It was drawn off nothing, because the only creation date on the phone was
   * `clientCreatedAt` — the moment THIS HANDSET first pulled the row, bound to
   * `now` by `upsertLeads` and never updated on conflict. On every lead the
   * office raised it says today, and says something else again after a
   * reinstall, so an age read off it is a confident wrong number on exactly
   * the leads a manager would ask about. `createdAt` is the office's own, and
   * null where it has not arrived — drawn as nothing rather than as new, which
   * is the same mistake wearing a different column.
   *
   * It sits BESIDE the rung age rather than replacing it. "Ninety days old,
   * four days on this rung" and "ninety days old, eighty on this rung" are two
   * different shops and only the pair tells them apart: the first is moving,
   * the second is stuck, and the rung age alone cannot say which.
   */
  const age =
    lead.createdAt == null ? null : daysBetween(isoDate(new Date(lead.createdAt)), today);

  /*
   * NOBODY NAMED TO DO THE OPERATIONAL HALF, said only where there IS one.
   *
   * `backOfficeAmId` is a seat, and an empty one is why a sample sits undispatched
   * and a GST never gets validated — the task falls through to the Lead Manager
   * and the salesman assumes the parcel is on its way. Asked of `roleAction` from
   * the back office's vantage rather than guessed from the rung, so the rule is
   * §7's own: where they have nothing to do, an empty seat is not a problem and
   * saying so would be a warning on most of the book.
   */
  const backOfficeGap = !lead.backOfficeAmId && roleAction(facts, 'back_office').actionable;

  /*
   * ONE WARNING, NOT FIVE. The row used to stack every caveat it had — the
   * lead going quiet, the visit cap, an empty back-office seat, the hold
   * reason, the closed note — so a troubled lead was a card a screen tall and
   * the list could not be scanned. The record still says all of them; the row
   * says the most urgent, in this order: a decision demanded now, the lead
   * going quiet, why it is parked, and the seat nobody holds.
   */
  const capLine = capCfg ? visitCapLabel(lead.stage, lead.visitCount, capCfg) : null;
  const deciding = !!capCfg && visitCapState(lead.stage, lead.visitCount, capCfg) === 'decide';
  const warning = deciding
    ? `${capLine} · decide now`
    : quiet
      ? quiet
      : lead.holdReason
        ? 'Waiting: ' + lead.holdReason
        : backOfficeGap
          ? 'No back office person set'
          : null;

  /* What it IS, in one quiet line: the rung and how long it has sat there,
     then the facts that tell two leads apart at a glance. */
  const facts2 = [
    rung ? stageLabel(rung) + (held && held > 0 ? ` ${held}d` : '') : null,
    age && age > 0 ? `${age}d old` : null,
    lead.salesType ? salesTypeLabel(lead.salesType as LeadSalesType) : null,
    lead.city,
    lead.estimatedPotentialPaise ? compactInrFromPaise(lead.estimatedPotentialPaise) + '/mo' : null,
    leadPriorityLabel(lead.priority),
    lead.hasOrder === 1 ? 'Order placed' : lead.hasCommitment === 1 ? 'Promised' : null,
    lead.archived ? 'Closed' : null,
  ].filter(Boolean);

  return (
    <PressableScale
      onPress={() => onPress(lead.id)}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingLeft: 14,
        paddingRight: 14,
        paddingVertical: 10,
        backgroundColor: pressed ? C.wash : C.surface,
        /* Late is drawn in the margin as well as in the words, so a screen of
           them can be scanned for red without being read. */
        borderLeftWidth: 3,
        borderLeftColor: overdue ? C.danger : 'transparent',
      })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]}>
          {lead.company?.trim() || lead.name}
        </T>
        <Badge tone={VIEW_TONE[view]}>{VIEW_LABEL[view]}</Badge>
      </View>

      {/* §7 — what he is supposed to DO, and when it is owed, on one line. */}
      <T numberOfLines={1} style={{ marginTop: 2, fontSize: 13, lineHeight: 18 }}>
        <T style={[{ fontSize: 13, color: ACTION_INK[action.tone] }, weight(600)]}>{action.label}</T>
        <T style={{ fontSize: 13, color: C.faint }}>{'  |  '}</T>
        <T style={[{ fontSize: 13, color: overdue ? C.danger : C.muted }, weight(overdue ? 600 : 400)]}>
          {owedLine ?? 'Nothing pending'}
        </T>
      </T>

      <T s="caption" numberOfLines={1} style={{ marginTop: 2 }}>
        {[lead.company?.trim() ? lead.name : null, ...facts2].filter(Boolean).join(' · ')}
      </T>

      {warning ? (
        <T numberOfLines={1} style={[{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.warnInk }, weight(500)]}>
          {warning}
        </T>
      ) : null}
    </PressableScale>
  );
}

/** How long a typed name waits before it becomes a query — the customers list's own pause. */
const SEARCH_PAUSE_MS = 250;

/**
 * The lead book, drawn the same wherever it is opened.
 *
 * It was a screen and is now a component, because the same list has two doors:
 * the Customers tab, where a salesman chooses between the shop he sells to and
 * the shop he is still working on, and the More screen's own Leads row, which
 * is the door that already existed and is in people's hands. Two copies of a
 * list this dense is two lists that disagree about one lead within a release,
 * and the half that drifts is always the half somebody is reading.
 *
 * It owns its OWN ScrollView rather than sitting inside the frame's, so both
 * doors pass `scroll={false}`: a frame that scrolls around a component that
 * scrolls is the one way to get two scroll positions and neither of them
 * working.
 *
 * `seedQuery` is what he had typed on the Customers half. That half's empty
 * search says "3 leads match — open Leads", and a tab that then opened on the
 * whole unsearched book would be the line lying about where the answer went.
 */
export function LeadsBook({ seedQuery = '' }: { seedQuery?: string } = {}) {
  const notify = useStore((s) => s.notify);
  const sheet = useStore((s) => s.sheet);
  const set = useStore((s) => s.set);

  /*
   * THREE NARROWINGS, AND THE SECOND ONE IS THE POINT OF THIS SCREEN.
   *
   * `view` is where the lead stands and is the row of chips this book has
   * always had — the same eight words, selecting on the funnel's rungs now
   * rather than on the six-word column. `when` is what is OWED, which is the
   * question a man planning a Tuesday morning actually asks and which nothing
   * here could put. `rung` narrows a picked band to one of its rungs and is
   * offered only where the book holds more than one.
   */
  const [view, setView] = React.useState<LeadView>('all');
  const [when, setWhen] = React.useState<LeadWhen>('any');
  /* How many under each stage chip, and whether the "when" sheet is open. */
  const [viewCounts, setViewCounts] = React.useState<Partial<Record<LeadView, number>> | null>(null);
  const [pickingWhen, setPickingWhen] = React.useState(false);
  const [rung, setRung] = React.useState<string | null>(null);
  const [rungs, setRungs] = React.useState<{ rung: string; count: number }[]>([]);
  const [rows, setRows] = React.useState<Lead[]>([]);
  /*
   * THE BOOK IS PAGED NOW, like the customers half. It read every lead and
   * handed the lot to the list, which on a territory where most shops are
   * still leads is thousands of sixty-column rows in memory before the first
   * one is drawn. `total` is SQL's count, never a loaded length.
   */
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreFailed, setMoreFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  /* Which answer is current — a chip tapped mid-read must not have the old
     question's late answer land on top of, or append to, the new one. */
  const asking = React.useRef(0);
  /*
   * WHAT IS ON SCREEN, for the next answer to move from. A narrowing — a chip,
   * a search, a lead closed on the record behind this one — lands as a fresh
   * page, and `animateLayoutFor` lets the rows that stay slide to their new
   * places and the ones that go fade, instead of the list jumping. Never on
   * the first read: a screen opening is not the list changing. Recorded after
   * each commit, never during render.
   */
  const drawnRows = React.useRef(0);
  const drawnOnce = React.useRef(false);
  React.useEffect(() => {
    drawnRows.current = rows.length;
    if (loaded) drawnOnce.current = true;
  });
  /*
   * THE SEARCH, the same box the customers half has. Eight stage chips and the
   * owed-when row were the only narrowing here, so finding one named shop in a
   * few hundred leads meant scrolling past all of them. `listLeads` has taken a
   * query all along — it reaches the shop, the person, the number and the town
   * — and nothing on the screen ever sent it one.
   *
   * What he has TYPED and what has been ASKED are kept apart for the reason the
   * customers list gives: every ask is a `LIKE '%…%'` scan that no index can
   * serve, and a pause turns a name into one query instead of one per letter.
   */
  const [typed, setTyped] = React.useState(seedQuery);
  const [asked, setAsked] = React.useState(seedQuery.trim());
  React.useEffect(() => {
    const t = setTimeout(() => setAsked(typed.trim()), SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [typed]);
  /* Null until the thresholds arrive from configuration. A default written in
     here would be a business rule living in a screen, and the sentence it
     produced would be wrong on any handset whose office had changed it. */
  const [cfg, setCfg] = React.useState<LeadThresholds | null>(null);
  /* Null until configuration arrives. A default typed here would be a business
     rule living in a screen, and it would disagree with the server the day the
     office changed it — which is the one disagreement this cap cannot afford,
     since the server is what refuses the visit. */
  const [capCfg, setCapCfg] = React.useState<VisitCapThresholds | null>(null);
  const [today] = React.useState(() => isoDate(new Date()));

  /* the form */
  const [formOpen, setFormOpen] = React.useState(false);
  /* See `save`. Not state: a second tap arrives before a re-render would. */
  const saving = React.useRef(false);
  const [name, setName] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [city, setCity] = React.useState('');
  /* WHERE HE MAY RAISE ONE. Read when the form opens, from what the office
     last said about his area — see `engines/lead-areas.ts`. */
  const [areas, setAreas] = React.useState<AreaRule>({ kind: 'free' });
  const [pickedArea, setPickedArea] = React.useState<AreaChoice | null>(null);
  /* The area picker is a page of the form's own sheet — see `area-picker.tsx`. */
  const [choosingArea, setChoosingArea] = React.useState(false);
  /**
   * THE CODE, NOT THE WORD, and the list is the office's.
   *
   * This held one of five labels typed into `engines/leads.ts`, which the wire
   * then translated down to four codes — three of which `leads.sources`, the
   * one authoritative list, has never contained. So every lead raised here was
   * filed under a channel nobody can count. What is stored now is the code, and
   * the words beside it are whatever the office last published.
   *
   * Null until the list has arrived and until he has answered. Defaulting to
   * the first chip is the app quietly answering a question about attribution on
   * a salesman's behalf, and "Salesman Prospecting" would then be the largest
   * bar on the chart by construction.
   */
  const [sources, setSources] = React.useState<LeadSource[] | null>(null);
  const [source, setSource] = React.useState<string | null>(null);
  /* §— what "Other" has to say. Only ever read when the source is `other`, and
     deliberately NOT cleared when the answer moves off it: the web form does
     the same, because it is a record of what somebody believed on the day. */
  const [sourceDetail, setSourceDetail] = React.useState('');
  /**
   * §2 — asked before anything else is typed, and null until it is answered.
   *
   * It picks the ladder, so it decides which questions the rest of the funnel
   * asks: a distributor answers thirty and a shop answers twelve. Defaulting
   * it to "Direct customer" would be the app quietly choosing, and every lead
   * anybody raised in a hurry would be on the wrong ladder with nothing on the
   * screen saying so.
   */
  const [salesType, setSalesType] = React.useState<LeadSalesType | null>(null);
  const [potential, setPotential] = React.useState('');
  const [followUp, setFollowUp] = React.useState<string | null>(null);
  const [cal, setCal] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [dup, setDup] = React.useState<DuplicateMatch | null>(null);
  /* §A and §C. All optional and all below a divider — a salesman outside a
     closed shop with a name and a number must still be able to save, and a
     fourteen-field form is how you get fourteen empty fields. */
  const [address, setAddress] = React.useState('');
  const [custType, setCustType] = React.useState<string | null>(null);
  const [requirement, setRequirement] = React.useState('');
  const [litres, setLitres] = React.useState('');
  const [decisionMaker, setDecisionMaker] = React.useState('');
  const [competitor, setCompetitor] = React.useState('');
  const [shopPhotoId, setShopPhotoId] = React.useState<string | null>(null);
  /* Asked at the qualify step whatever happens here, and optional on the
     form — but a card usually prints it, and a scan can read it. */
  const [gstin, setGstin] = React.useState('');
  const scanCfg = useLeadScan();
  const [scanning, setScanning] = React.useState(false);
  /* Bumped on every fresh scan, so the panel starts blank rather than with
     the last shop's photos — a key, not an effect that resets state. */
  const [scanKey, setScanKey] = React.useState(0);
  /* "Speak about the shop" — the whole form from one description. Its own
     key for the same reason: a fresh open starts with an empty box. */
  const voiceOn = useLeadVoice();
  const [voicing, setVoicing] = React.useState(false);
  const [voiceKey, setVoiceKey] = React.useState(0);

  /* One object, so a caller that adds a fourth narrowing does not add a fourth
     argument to two functions. `today` travels with it rather than being read
     inside the query: the clock is read once, at the top of this component. */
  const filter: LeadBookFilter = React.useMemo(
    () => ({ view, rung, when, today }),
    [view, rung, when, today],
  );

  const load = React.useCallback(async () => {
    const ticket = ++asking.current;
    try {
      const [page, g, t, c, srcs, vc] = await Promise.all([
        listLeadsPage(filter, asked, 0),
        /* The rungs under the picked band, counted in SQLite over the same
           narrowing — counting from the loaded page would read zero for every
           rung the first thirty rows happen not to reach. */
        rungsInBook(filter, asked),
        leadThresholds(),
        visitCapThresholds(),
        leadSources(),
        leadViewCounts(
          LEAD_VIEWS.map((v) => v.value),
          { when: filter.when, today: filter.today },
          asked,
        ).catch(() => null),
      ]);
      if (ticket !== asking.current) return;
      if (drawnOnce.current) animateLayoutFor(Math.max(drawnRows.current, page.rows.length));
      setViewCounts(vc);
      setRows(page.rows);
      setTotal(page.total);
      setHasMore(page.hasMore);
      setMoreFailed(false);
      setRungs(g);
      setCfg(t);
      setCapCfg(c);
      setSources(srcs);
    } finally {
      if (ticket === asking.current) setLoaded(true);
    }
  }, [filter, asked]);

  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  const loadMore = React.useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const ticket = asking.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await listLeadsPage(filter, asked, rows.length, total);
      if (ticket !== asking.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      setHasMore(page.hasMore && page.rows.length > 0);
    } catch {
      if (ticket === asking.current) setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, filter, asked, rows.length, total]);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  /*
   * WHAT HE TYPED SURVIVES A DISMISSAL, and it did not.
   *
   * `BottomSheet` closes on a scrim tap and on Android's back gesture, and the
   * only way back in is this button — which used to clear all fourteen fields
   * on the way IN. So one stray tap above the longest form in the app, filled
   * one-handed in the street, cost the whole shop the moment he pressed "+ Add
   * lead" again, with nothing asked and nothing said.
   *
   * Nothing is cleared now until something has been done with it: a save that
   * worked, or Cancel, which is somebody deliberately saying to throw it away.
   * Re-opening shows him exactly what he had.
   */
  const clearForm = React.useCallback(() => {
    setName('');
    setCompany('');
    setMobile('');
    setCity('');
    setPickedArea(null);
    setChoosingArea(false);
    setSource(null);
    setSourceDetail('');
    setSalesType(null);
    setPotential('');
    setFollowUp(null);
    setAddress('');
    setCustType(null);
    setRequirement('');
    setLitres('');
    setDecisionMaker('');
    setCompetitor('');
    setShopPhotoId(null);
    setGstin('');
    setScanning(false);
    setVoicing(false);
    setErr(null);
    setDup(null);
  }, []);

  const openForm = React.useCallback(() => {
    void territoryState().then((t) => setAreas(areaRule(t)));
    setFormOpen(true);
  }, []);

  /* The + sheet on every screen offers "Add lead", which lands here with the
     form already asked for — the salesman is standing outside the shop. */
  React.useEffect(() => {
    if (sheet === 'leadForm') {
      set({ sheet: null });
      openForm();
    }
  }, [sheet, set, openForm]);

  const shootShop = async () => {
    /* `parentId: 'pending'` because the lead does not exist yet — the salesman
       shoots the shop while he is standing in front of it and types the rest
       afterwards. `handleLead` binds it the moment the row is written. */
    const shot = await takePhoto({ parentType: 'lead', parentId: 'pending', kind: 'shop_photo' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason, 'warn');
      return;
    }
    setShopPhotoId(shot.mediaId);
  };

  /* "Fill the form" in the scan panel or the voice panel. Only what he
     ticked arrives, and it overwrites — he has just looked at each value. The
     scan sends six answers and the voice up to sixteen; both land here, so the
     area rule is applied once whichever way the town arrived. */
  const applyFill = (fill: LeadScanFill & LeadVoiceFill, from: 'photos' | 'voice') => {
    if (fill.salesType) {
      const offered = offeredSalesTypes().find((t) => t.code === fill.salesType);
      if (offered) setSalesType(offered.code);
    }
    if (fill.company) setCompany(fill.company);
    if (fill.name) setName(fill.name);
    if (fill.mobile) setMobile(fill.mobile);
    if (fill.address) setAddress(fill.address);
    if (fill.gstin) setGstin(fill.gstin);
    if (fill.source && (sources ?? []).some((s) => s.code === fill.source)) {
      setSource(fill.source);
      if (fill.source === OTHER_SOURCE && fill.sourceDetail) setSourceDetail(fill.sourceDetail);
    }
    if (fill.potential) setPotential(fill.potential);
    if (fill.followUp && fill.followUp >= today) setFollowUp(fill.followUp);
    if (fill.custType && CUSTOMER_TYPES.some((t) => t.value === fill.custType)) setCustType(fill.custType);
    if (fill.requirement) setRequirement(fill.requirement);
    if (fill.litres) setLitres(fill.litres);
    if (fill.decisionMaker) setDecisionMaker(fill.decisionMaker);
    if (fill.competitor) setCompetitor(fill.competitor);
    let outside: string | null = null;
    const loc = fill.location;
    if (loc?.kind === 'area') {
      setPickedArea(loc.area);
      if (loc.city) setCity(loc.city);
    } else if (loc?.kind === 'free') {
      setCity(loc.city);
    } else if (loc?.kind === 'outside') {
      outside = loc.city;
    }
    setDup(null);
    setScanning(false);
    setVoicing(false);
    setErr(
      outside
        ? areas.kind === 'none'
          ? 'No area is set for you yet. You cannot add a lead. Ask the office to set one.'
          : outside + ' is not in your area. Choose the area this shop is in.'
        : null,
    );
    notify(
      from === 'photos'
        ? 'Filled from the photos. Check each field before adding.'
        : 'Filled from what you said. Check each field before adding.',
    );
  };

  /* A refusal on the form says so in the box above the buttons AND in the hand:
     the box shakes and the phone buzzes `warning`, because the box may be
     below the fold of a sheet this long and the buzz is what says "look". */
  const refusal = useShake('warning');
  const refuse = (message: string) => {
    setErr(message);
    refusal.shake();
  };

  const save = async () => {
    /* One lead per press. `createLead` awaits a duplicate check, a GPS fix and
       a write, and a second tap inside that window is the ordinary way a shop
       ends up on the book twice — the duplicate check cannot catch it, because
       neither row is written yet when the other starts. A ref rather than
       state: state is a render away and the second tap is not. */
    if (saving.current) return;

    /* The ladder is asked FIRST and refused first, in that order, so the
       message somebody reads names the question at the top of the form rather
       than the one they have just finished typing. */
    if (!salesType) return refuse('Choose the kind of sale first.');
    /* EITHER, and that is what the sentence always said: a shop board names
       the shop and nobody in it, and a lead raised from one has no person yet. */
    if (!name.trim() && !company.trim()) return refuse('Write a name or the shop name.');
    if (mobile.replace(/\D/g, '').length < 10) return refuse('Write a 10-digit mobile number.');
    if (!source) return refuse('Choose how you found them.');
    /* Mahek's rule: a lead is raised inside his own area. Asked here so it is
       never refused in the office after the shop, the photograph and the pin
       are already behind it. */
    if (areas.kind === 'none') {
      return refuse('No area is set for you yet. You cannot add a lead. Ask the office to set one.');
    }
    if (areas.kind === 'pick' && !pickedArea) return refuse('Choose the area this shop is in. It must be in your area.');
    if (pickedArea && !pickedArea.city && !city.trim()) return refuse('Which town in ' + pickedArea.label + '?');
    /* Refused on the phone as well as in the office, because being told after
       the fact loses the sentence he had in mind while he was standing there. */
    if (source === OTHER_SOURCE && !sourceDetail.trim()) {
      return refuse('You chose "Other". Write where this lead came from.');
    }
    const gst = gstin.toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (gst && gst.length !== 15) return refuse('A GST number is 15 letters and numbers. Check it, or leave it empty.');

    saving.current = true;
    try {
      const rupees = Number(potential.replace(/[^\d]/g, ''));
      const result = await createLead({
        /* The person where there is one, the shop where there is not — the
           lead needs a name on its row either way. */
        name: name.trim() || company.trim(),
        contactPerson: name.trim() || null,
        gstin: gst || null,
        company,
        mobile,
        city: pickedArea?.city ?? city,
        area: pickedArea?.area ?? null,
        state: pickedArea?.state ?? null,
        source,
        /* Where it actually came from, on its own column at both ends —
           `customers.lead_source_detail` on the server and `leads.sourceDetail`
           here. It used to ride in the note prefixed "Source details: ",
           because nothing carried it up: that put the answer he had just been
           refused for not giving where a person could read it and no report
           could count it. */
        sourceDetail: source === OTHER_SOURCE ? sourceDetail : null,
        /* Rupees on the screen, paise in the store — the only place the two meet. */
        estimatedPotentialPaise: rupees > 0 ? rupees * 100 : null,
        nextFollowUpDate: followUp,
        salesType,
        address,
        customerType: custType,
        requirement,
        monthlyVolumeLitres: Number(litres.replace(/[^\d]/g, '')) || null,
        decisionMaker,
        competitorName: competitor,
        shopPhotoId,
        today,
      });

      if (!result.ok) {
        setDup(result.duplicate ?? null);
        refuse(result.message);
        return;
      }

      /* What a man works this week, he works tomorrow: the area goes to the
         top of the picker's "recently" — only for a lead actually saved. */
      if (pickedArea) void rememberPickedArea(pickedArea.key).catch(() => undefined);
      setFormOpen(false);
      /* One of the two places anything is thrown away — this one and Cancel. The
         next "+ Add lead" is a different shop; this one is on the list behind
         the sheet. */
      clearForm();
      void load();
      notify('Lead added · ' + (company.trim() || name.trim()));
    } finally {
      saving.current = false;
    }
  };

  const openDuplicate = () => {
    if (!dup) return;
    setFormOpen(false);
    if (dup.kind === 'customer') {
      set({ custId: dup.id, pTab: 0 });
      router.push('/customer');
    } else {
      router.push(`/lead?id=${dup.id}&from=leads`);
    }
  };

  const openLead = React.useCallback((id: string) => {
    router.push(`/lead?id=${id}&from=leads`);
  }, []);

  /* Only the first screenful settles in. Rows mounted later by scrolling or
     by the next page are arriving under his thumb, and a fade there reads as
     the list lagging rather than as the list arriving. */
  const renderRow = React.useCallback(
    ({ item, index }: ListRenderItemInfo<Lead>) => {
      const row = (
        <LeadRow
          lead={item}
          today={today}
          cfg={cfg}
          capCfg={capCfg}
          onPress={openLead}
        />
      );
      return index < 8 ? <Stagger index={index}>{row}</Stagger> : row;
    },
    [today, cfg, capCfg, openLead],
  );

  /*
   * THE CONTROLS ARE FIXED ABOVE THE LIST, never its header — a header
   * scrolls away with the first rows, and a salesman two hundred leads down
   * could not see what he had narrowed to or reach the box to search again.
   *
   * TWO CHIP ROWS AND NOT A MENU: both change what the list IS, and a list
   * whose subject is hidden behind a menu is one people misread. The rung row
   * is offered only where the band holds more than one, with its counts.
   */
  const rungChips = React.useMemo(
    () => [
      { value: '__all', label: 'All ' + VIEW_LABEL[view].toLowerCase() },
      ...rungs.map((r) => ({ value: r.rung, label: stageLabel(r.rung as LeadStage) })),
    ],
    [rungs, view],
  );
  const rungCounts = React.useMemo(
    () => Object.fromEntries(rungs.map((r) => [r.rung, r.count])) as Record<string, number>,
    [rungs],
  );
  const whenLabel = LEAD_WHENS.find((w) => w.value === when)!.label;
  /*
   * THE SAME TOOLBAR AS THE CUSTOMERS HALF: a search box and two square
   * buttons, one row of chips with counts, one line saying what is shown.
   *
   * "When" was a second chip row stacked on the stage row, and two rows of
   * identical pills read as one bank of buttons doing one kind of thing. It is
   * a narrowing he sets once a morning, so it lives behind the clock button
   * and is said out loud on the status line whenever it is not "Any day".
   */
  const controls = (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <SearchBox
          value={typed}
          onChange={setTyped}
          onClear={() => {
            setTyped('');
            setAsked('');
          }}
          placeholder="Name, shop, phone or city"
        />
        <ToolButton
          icon="clock"
          label={'Due: ' + whenLabel}
          on={when !== 'any'}
          onPress={() => setPickingWhen(true)}
        />
        <ToolButton icon="add" label="Add a lead" tone="primary" onPress={openForm} />
      </View>
      <ChipRow
        chips={LEAD_VIEWS}
        value={view}
        counts={viewCounts}
        onChange={(v) => {
          setView(v);
          /* The rung belongs to the band it was picked under. Carried across
             it would narrow the new band to a rung it does not carry. */
          setRung(null);
        }}
      />
      {rungs.length > 1 ? (
        <ChipRow
          chips={rungChips}
          value={rung ?? '__all'}
          onChange={(v) => setRung(v === '__all' ? null : v)}
          counts={rungCounts}
        />
      ) : null}
      {/* A count under a search is a count of the MATCHES, and says so. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T s="caption" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          {!loaded
            ? 'Reading your leads…'
            : total
              ? `${grouped(total)} ${total === 1 ? 'lead' : 'leads'}` + (asked ? ` · “${asked}”` : '')
              : 'No leads match'}
        </T>
        <Pressable onPress={() => setPickingWhen(true)} accessibilityRole="button" hitSlop={8}>
          <T numberOfLines={1} style={[{ fontSize: 13, color: when === 'any' ? C.primaryDeep : C.danger }, weight(600)]}>
            {(when === 'any' ? 'Most urgent first' : whenLabel) + ' ▾'}
          </T>
        </Pressable>
      </View>
    </View>
  );

  /*
   * AN EMPTY LIST SAYS WHICH KIND OF EMPTY IT IS.
   *
   * Nothing at all, nothing at this rung, and nothing owed on these days are
   * three different facts and only one of them is about the book. A salesman
   * who has picked Overdue and sees "No leads yet" concludes his leads are
   * gone; what is true is that he owes nobody anything, which is the best news
   * on the screen.
   */
  const empty = React.useMemo(
    () => (
      <Card style={{ marginHorizontal: 16, paddingHorizontal: 16, paddingVertical: 32 }} padded={false}>
        <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
          {!loaded
            ? 'Loading your leads…'
            : asked
            ? `No lead matches “${asked}”`
            : when !== 'any'
            ? 'Nothing ' + LEAD_WHENS.find((w) => w.value === when)!.label.toLowerCase()
            : view === 'all'
              ? 'No leads yet'
              : 'Nothing at ' + VIEW_LABEL[view]}
        </T>
        <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
          {asked
            ? 'Search looks at the shop, the person, the number and the town. Clear it to see all leads.'
            : when !== 'any'
            ? 'All leads are still here. This shows only pending work.'
            : view === 'all'
              ? 'Add a shop you visit or a name someone gives you.'
              : 'All leads are still under All. Nothing is deleted.'}
        </T>
      </Card>
    ),
    [view, when, asked, loaded],
  );

  return (
    <View style={{ flex: 1 }}>
      {/*
        * IT IS A `FlatList`, and for the reason the customers list next door
        * spells out: the rows were `rows.map()` inside a `ScrollView`, so every
        * lead was mounted at once — and this card is now a good deal heavier
        * than it was, carrying a verb, a rung, a counter and the marks. A few
        * hundred of those built on the JS thread is a screen that stutters
        * exactly when somebody is scrolling it looking for one shop.
        */}
      {controls}
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 24 }}
        data={rows}
        keyExtractor={(x) => x.id}
        renderItem={renderRow}
        ItemSeparatorComponent={RowGap}
        ListEmptyComponent={empty}
        ListFooterComponent={
          rows.length ? (
            <PageFooter
              loading={loadingMore}
              failed={moreFailed}
              done={!hasMore}
              total={total}
              noun="lead"
              onRetry={() => void loadMore()}
            />
          ) : null
        }
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.6}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={9}
        removeClippedSubviews={Platform.OS === 'android'}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      />

      {/* ------------------------------------------------------------ form */}
      <BottomSheet
        open={formOpen}
        onClose={() => {
          setChoosingArea(false);
          setFormOpen(false);
        }}
        page={choosingArea && areas.kind === 'pick' ? 'area' : 'form'}
        scroll>
        {choosingArea && areas.kind === 'pick' ? (
          <AreaPickerPage
            choices={areas.choices}
            pickedKey={pickedArea?.key ?? null}
            onPick={(a) => {
              setPickedArea(a);
              setErr(null);
              setChoosingArea(false);
            }}
            onBack={() => setChoosingArea(false)}
          />
        ) : (
        <>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>New lead</T>
            <T s="caption" style={{ marginTop: 2 }}>
              We check the number in your list before saving.
            </T>
          </View>
          {/* THE SCAN, in the header rather than down the form: it fills the
              first six answers, so it is offered before any of them is typed.
              Not drawn at all where the office cannot read photos — a button
              that fails when pressed is worse than none. */}
          {scanCfg.available ? (
            <ToolButton
              icon="scan"
              label="Scan a visiting card or shop board"
              on={scanning}
              onPress={() => {
                if (!scanning) setScanKey((k) => k + 1);
                setScanning((v) => !v);
                setVoicing(false);
              }}
            />
          ) : null}
        </View>

        {/* SPEAKING, offered as a sentence rather than an icon: it fills the
            whole form, so it is the first thing a salesman outside a shop
            should see — and a mic glyph in a header reads as "voice typing
            into one box", which is a different promise. Not drawn where the
            office cannot hear or read; a button that fails is worse than none. */}
        {voiceOn && !voicing ? (
          <Pressable
            onPress={() => {
              setVoiceKey((k) => k + 1);
              setVoicing(true);
              setScanning(false);
            }}
            accessibilityRole="button"
            style={({ pressed }) => ({
              marginTop: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              padding: 12,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: C.primaryEdge,
              backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
            })}>
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: radius.pill,
                backgroundColor: C.primary,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <Icon name="mic" size={19} color={C.surface} strokeWidth={1.8} />
            </View>
            <View style={{ flex: 1 }}>
              <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Speak about the shop</T>
              <T s="caption" style={{ marginTop: 2 }}>
                Say everything, in any language. We fill the form for you to check.
              </T>
            </View>
          </Pressable>
        ) : null}

        {voicing ? (
          <LeadVoicePanel
            key={voiceKey}
            areas={areas}
            lists={{
              salesTypes: offeredSalesTypes(),
              sources: sources ?? [],
              customerTypes: CUSTOMER_TYPES.map((t) => ({ code: t.value, label: t.label })),
            }}
            current={{
              name,
              company,
              mobile,
              gstin,
              location: pickedArea?.label ?? city,
              potential,
              address,
              requirement,
              litres,
              decisionMaker,
              competitor,
            }}
            onClose={() => setVoicing(false)}
            onFill={(fill) => applyFill(fill, 'voice')}
          />
        ) : null}

        {scanning ? (
          <LeadScanPanel
            key={scanKey}
            maxImages={scanCfg.maxImages}
            areas={areas}
            current={{ company, name, mobile, location: pickedArea?.label ?? city, address, gstin }}
            onClose={() => setScanning(false)}
            onFill={(fill) => applyFill(fill, 'photos')}
          />
        ) : null}

        {/* --------------------------------------------------- §2 the ladder
            First on the form, because it decides what the rest of the funnel
            asks — and changed afterwards only deliberately, from the record,
            with a reason. Three chips rather than a dropdown: the sentence
            under each is what somebody standing outside a shop reads to
            choose, and a dropdown hides two of the three. */}
        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What kind of sale is this?</SectionLabel>
          <View style={{ gap: 8 }}>
            {/* OFFERED, not all three. Mahek does not appoint distributors
                through MahekOne, so that ladder is withdrawn for new leads —
                the note on `SALES_TYPES` in the funnel engine has the whole of
                it. The leads already on it keep everything they have. */}
            {offeredSalesTypes().map((t) => (
              <Choice
                key={t.code}
                label={t.label}
                sub={t.hint}
                selected={salesType === t.code}
                onPress={() => { setSalesType(t.code); setErr(null); }}
                style={{ alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 10 }}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who you spoke to</SectionLabel>
          <Input value={name} onChangeText={(v) => { setName(v); setErr(null); }} placeholder="Suresh Patil" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Shop name</SectionLabel>
          <Input value={company} onChangeText={setCompany} placeholder="Patil Hardware & Paints" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Mobile</SectionLabel>
          <Input
            value={mobile}
            onChangeText={(v) => { setMobile(v); setErr(null); setDup(null); }}
            placeholder="98220 11001"
            keyboardType="phone-pad"
          />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>GST number</SectionLabel>
          <Input
            value={gstin}
            onChangeText={(v) => { setGstin(v.toUpperCase()); setErr(null); }}
            placeholder="27AAPFU0939F1ZV"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={20}
          />
          <T s="caption" style={{ marginTop: 6 }}>If they have one. It is needed later to qualify the lead.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          {areas.kind === 'none' ? (
            <T style={{ color: C.warnInk }}>
              No area is set for you yet. You can add leads only in your own area. Ask the office to set one.
            </T>
          ) : (
            <>
              {areas.kind === 'pick' ? (
                <AreaField
                  choices={areas.choices}
                  picked={pickedArea}
                  onPick={(a) => {
                    setPickedArea(a);
                    setErr(null);
                  }}
                  onOpen={() => setChoosingArea(true)}
                />
              ) : null}
              {/* A town picks itself; a state, or no rule at all, asks for one. */}
              {pickedArea?.city ? null : (
                <>
                  <SectionLabel style={{ marginBottom: 6 }}>City</SectionLabel>
                  <Input value={city} onChangeText={setCity} placeholder="Nagpur" />
                </>
              )}
            </>
          )}
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>How you found them</SectionLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(sources ?? []).map((s) => (
              <Choice
                key={s.code}
                label={s.label}
                selected={source === s.code}
                onPress={() => setSource(s.code)}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </View>
        </View>

        {/*
          * ONLY UNDER "OTHER", and required there — the same shape the web
          * intake form draws, for the same reason. "Other" is the cheapest
          * answer on any list: left free it becomes the biggest bar on the
          * chart with nothing behind it, and the sentences are what tell Mahek
          * which eleventh channel is worth adding to the list. A box that is
          * dead on nine answers in ten is furniture, and people stop reading
          * furniture, so it is drawn rather than disabled.
          */}
        {source === OTHER_SOURCE ? (
          <View style={{ marginTop: 12 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Source details</SectionLabel>
            <Input
              value={sourceDetail}
              onChangeText={(v) => { setSourceDetail(v); setErr(null); }}
              placeholder="A builder nearby sent him"
            />
          </View>
        ) : null}

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>How much they can buy a month</SectionLabel>
          <Input
            value={potential}
            onChangeText={setPotential}
            placeholder="40000"
            keyboardType="number-pad"
          />
          <T s="caption" style={{ marginTop: 6 }}>In rupees, about. Leave it empty if you do not know.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Next follow-up on</SectionLabel>
          <Pressable
            onPress={() => setCal(true)}
            accessibilityRole="button"
            style={{
              minHeight: 52,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.lg,
              backgroundColor: C.surface,
              justifyContent: 'center',
              paddingHorizontal: 14,
            }}>
            <T style={{ fontSize: 16, color: followUp ? C.ink : C.faint }}>
              {followUp ? dmy(followUp) : 'Choose a day'}
            </T>
          </Pressable>
        </View>

        <Divider style={{ marginTop: 20, marginBottom: 4 }} />
        <SectionLabel style={{ marginTop: 12 }}>What you found in the shop</SectionLabel>
        <T s="caption" style={{ marginTop: 4 }}>
          All optional. Save what you have. Add the rest later.
        </T>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Where the shop is</SectionLabel>
          <Input value={address} onChangeText={setAddress} placeholder="Shop 4, Itwari Market, near the bus stand" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What kind of business</SectionLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CUSTOMER_TYPES.map((t) => (
              <Choice
                key={t.value}
                label={t.label}
                selected={custType === t.value}
                onPress={() => setCustType(custType === t.value ? null : t.value)}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </View>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What they want</SectionLabel>
          <Input value={requirement} onChangeText={setRequirement} placeholder="Thinner for a spray booth" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>How much a month</SectionLabel>
          <Input value={litres} onChangeText={setLitres} placeholder="200" keyboardType="number-pad" />
          {/* LITRES, not cans. There is no pack size agreed yet — a shop says
              "about two hundred litres" long before anybody knows what they
              will buy it as. */}
          <T s="caption" style={{ marginTop: 6 }}>In litres, as they say it.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who decides</SectionLabel>
          <Input value={decisionMaker} onChangeText={setDecisionMaker} placeholder="The owner, Mr Patil" />
          <T s="caption" style={{ marginTop: 6 }}>If that is not the person you spoke to.</T>
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Who they buy from now</SectionLabel>
          <Input value={competitor} onChangeText={setCompetitor} placeholder="Asian Paints" />
        </View>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Shop photo</SectionLabel>
          <DashedButton
            label={shopPhotoId ? 'Photo taken \u2713 \u00b7 retake' : 'Take a photo'}
            onPress={shootShop}
          />
        </View>

        <Presence show={!!err}>
          <Animated.View
            style={[{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }, refusal.style]}>
            <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
            {dup ? (
              <SecondaryButton
                label={dup.kind === 'customer' ? 'Open ' + dup.name : 'Open the lead'}
                onPress={openDuplicate}
                style={{ marginTop: 10 }}
              />
            ) : null}
          </Animated.View>
        </Presence>

        {/* Closing the sheet any other way — the scrim, the back gesture —
            keeps what he typed and brings it straight back. Cancel is the one
            gesture that means throw it away, so it is the one that clears. */}
        <T s="caption" style={{ marginTop: 18 }}>
          If you close this by mistake, your typing is kept. Cancel deletes it.
        </T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <SecondaryButton
            label="Cancel"
            onPress={() => {
              setFormOpen(false);
              clearForm();
            }}
            style={{ flex: 1, borderRadius: radius.xl }}
          />
          <PrimaryButton label="Add lead" onPress={save} style={{ flex: 1, borderRadius: radius.xl }} />
        </View>
        </>
        )}
      </BottomSheet>

      {/* -------------------------------------------------------- when owed */}
      <BottomSheet open={pickingWhen} onClose={() => setPickingWhen(false)}>
        <T style={[{ fontSize: 17, color: C.ink, marginBottom: 8 }, weight(600)]}>Show leads due</T>
        {LEAD_WHENS.map((w) => {
          const on = when === w.value;
          return (
            <Pressable
              key={w.value}
              onPress={() => {
                setWhen(w.value);
                setPickingWhen(false);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 52,
                  borderBottomWidth: 1,
                  borderBottomColor: C.hairline,
                },
                pressed && { backgroundColor: C.wash },
              ]}>
              <T style={[{ flex: 1, fontSize: 15, color: on ? C.primaryDeep : C.ink }, weight(on ? 600 : 500)]}>
                {w.label}
              </T>
              {on ? <Icon name="tick" size={18} color={C.primaryDeep} /> : null}
            </Pressable>
          );
        })}
      </BottomSheet>

      {/* ------------------------------------------------------- follow-up */}
      <BottomSheet open={cal} onClose={() => setCal(false)}>
        <Calendar
          key={cal ? 'open' : 'shut'}
          selected={followUp ?? ''}
          disabledReason={(iso) => (iso < today ? 'That day has passed.' : null)}
          onPick={(iso) => {
            setFollowUp(iso);
            setCal(false);
          }}
        />
        <SecondaryButton label="Close" onPress={() => setCal(false)} style={{ minHeight: 48, height: 48, marginTop: 10 }} />
      </BottomSheet>
    </View>
  );
}
