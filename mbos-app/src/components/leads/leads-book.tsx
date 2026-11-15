import React from 'react';
import { Animated, Text, View, Pressable, FlatList, RefreshControl, Platform, ScrollView, type ListRenderItemInfo } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SecondaryButton, T } from '../ui/primitives';
import { PillButton } from '../ui/v3';
import { feedback } from '../ui/feedback';
import { HERO } from '../shell/Chrome';
import { BottomSheet, Calendar } from '../ui/overlays';
import { color as C, weight, type BadgeTone } from '../../theme/tokens';
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
import { discardQueuedMedia } from '../../sync/media';
import { LeadScanPanel, useLeadScan, type LeadScanFill } from './lead-scan';
import { AreaField, AreaPickerPage } from './area-picker';
import { rememberPickedArea } from '../../data/lead-areas';
import { LeadVoicePanel, useLeadVoice } from './lead-voice';
import type { LeadVoiceFill } from '../../engines/lead-voice';
import { answeredDetails, detailsSummary, fillTouchesDetails } from '../../engines/lead-form';
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
  capStageOf,
  gstinRefusal,
  normaliseGstin,
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
import { cleanDecimal, parseDecimal } from '../../lib/decimal-input';
import { cleanAmount, paiseFromTyped } from '../../lib/money-input';
import { useStore } from '../../state/store';
import { PressableScale, Presence, Stagger, animateLayoutFor, useShake } from '../ui/motion';
import { BoxInput, CardHead, FormRow, LeadCard, LeadGlyph, StagePill, WarnPill, WashChip } from './v3-parts';

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
  suspect: 'info',
  prospect: 'teal',
  qualification: 'amber',
  sample_trial: 'amber',
  negotiation: 'amber',
  first_order: 'amber',
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

/** V3 draws the book as separate cards, ten points apart. */
function RowGap() {
  return <View style={{ height: 10 }} />;
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
  /* `capStageOf` rather than the six-word column, and the outbox counted —
     see both for the Prospect told to decide again and the counter one visit
     behind the visit screen. */
  const capStage = capStageOf(lead);
  const capVisits = lead.visitCount + (lead.pendingVisits ?? 0);
  const capLine = capCfg ? visitCapLabel(capStage, capVisits, capCfg) : null;
  const deciding = !!capCfg && visitCapState(capStage, capVisits, capCfg) === 'decide';
  /* A LEAD THE OFFICE REFUSED IS NOT A LEAD, and it used to look exactly
     like one. The commonest refusal is a duplicate — the shop was already on
     the book — and the row stayed on the list reading like any other, so he
     went on adding notes and visits to a record the office would never hold.
     It is said first, above every other warning, because nothing else on the
     card matters until it is settled on Not accepted. */
  const refused = lead.syncState === 'rejected' || lead.syncState === 'blocked';
  const warning = refused
    ? 'Not accepted by the office. Open Not accepted to see why'
    : deciding
    ? `${capLine} · decide now`
    : quiet
      ? quiet
      : lead.holdReason
        ? 'Waiting: ' + lead.holdReason
        : backOfficeGap
          ? 'No back office person set'
          : null;

  /* What it IS, in one quiet row: the person, how long it has sat on this
     rung and how old it is, then the facts that tell two leads apart. V3
     gives the contact and the town a glyph and colours the priority, the
     promise and the closed mark; the words are the same. */
  const priority = leadPriorityLabel(lead.priority);
  const prioKey = (lead.priority ?? '').trim().toLowerCase();
  const onHold = view === 'on_hold';
  const heldWord = onHold ? 'on hold' : 'on rung';
  const ageLine = [
    held && held > 0 ? `${held}d ${heldWord}` : null,
    age && age > 0 ? `${age}d old` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  type Fact = { text: string; glyph?: 'person' | 'pin' | 'flag'; ink?: string; a11y?: string };
  const factRow: Fact[] = [
    lead.company?.trim() && lead.name ? { text: lead.name, glyph: 'person' as const, a11y: 'Contact ' + lead.name } : null,
    refused ? { text: action.label, ink: ACTION_INK[action.tone] } : null,
    refused ? { text: owedLine ?? 'Nothing pending' } : null,
    ageLine ? { text: ageLine, a11y: (rung ? stageLabel(rung) + ', ' : '') + ageLine } : null,
    lead.salesType ? { text: salesTypeLabel(lead.salesType as LeadSalesType) } : null,
    lead.city ? { text: lead.city, glyph: 'pin' as const, a11y: 'Area ' + lead.city } : null,
    lead.estimatedPotentialPaise ? { text: compactInrFromPaise(lead.estimatedPotentialPaise) + '/mo' } : null,
    priority
      ? {
          text: priority.replace(/ priority$/, ''),
          glyph: prioKey === 'high' ? ('flag' as const) : undefined,
          ink: prioKey === 'high' ? C.danger : prioKey === 'medium' ? C.warnInk : undefined,
          a11y: priority,
        }
      : null,
    lead.hasOrder === 1
      ? { text: 'Order placed', ink: C.success }
      : lead.hasCommitment === 1
        ? { text: 'Promised', ink: C.success }
        : null,
    lead.archived ? { text: 'Closed' } : null,
  ].filter(Boolean) as Fact[];

  /* The hold reason is a quiet line of its own on a parked lead (V3), and
     the warning pill otherwise. */
  const waitingLine = !refused && !deciding && !quiet && lead.holdReason && onHold ? warning : null;
  const pillWarning = refused || waitingLine ? null : warning;

  return (
    <PressableScale
      onPress={() => onPress(lead.id)}
      accessibilityRole="button"
      accessibilityHint={refused ? 'Not accepted by the office. Open Not accepted to see why.' : undefined}
      style={({ pressed }) => ({
        marginHorizontal: 14,
        paddingLeft: 16,
        paddingRight: 16,
        paddingVertical: 14,
        borderRadius: 20,
        overflow: 'hidden',
        backgroundColor: pressed ? C.wash : C.surface,
        borderWidth: refused ? 1.5 : 0,
        borderColor: '#F2C9C6',
      })}>
      {/* Late is drawn in the margin as well as in the words, so a screen of
          them can be scanned for red without being read. */}
      {overdue ? (
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: C.danger }} />
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21, color: C.ink }, weight(700)]}>
          {lead.company?.trim() || lead.name}
        </T>
        <StagePill tone={VIEW_TONE[view]} text={rung && view !== 'all' && view !== 'on_hold' ? stageLabel(rung) : VIEW_LABEL[view]} />
      </View>

      {refused ? (
        <WarnPill tone="danger" text="Not accepted · see Not accepted" style={{ marginTop: 8 }} />
      ) : (
        <>
          {/* §7 — what he is supposed to DO, then when it is owed. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {onHold ? (
              <LeadGlyph name="pause" size={16} color={C.muted} />
            ) : (
              <LeadGlyph name="arrow" size={16} color={ACTION_INK[action.tone]} />
            )}
            <T
              numberOfLines={2}
              style={[{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, color: onHold ? C.muted : ACTION_INK[action.tone] }, weight(onHold ? 600 : 700)]}>
              {onHold ? 'Paused, not lost' : action.label}
            </T>
          </View>
          {owedLine ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <Icon name={owed && owed.source === 'promise' && !overdue && owed.daysLate < 0 ? 'cal' : 'clock'} size={14} color={overdue ? C.danger : C.muted} strokeWidth={2.2} />
              <T numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: overdue ? C.danger : C.muted }, weight(overdue ? 700 : 600)]}>
                {owedLine}
              </T>
            </View>
          ) : (
            <T style={[{ marginTop: 4, fontSize: 13, lineHeight: 18, color: C.faint }, weight(600)]}>Nothing pending</T>
          )}
        </>
      )}

      {factRow.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 6, marginTop: refused ? 8 : 10 }}>
          {factRow.map((f, i) => (
            <View key={i} accessible={!!f.a11y} accessibilityLabel={f.a11y} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {f.glyph === 'flag' ? (
                <LeadGlyph name="flag" size={13} color={f.ink ?? C.muted} />
              ) : f.glyph ? (
                <Icon name={f.glyph} size={13} color={f.ink ?? C.muted} strokeWidth={2.2} />
              ) : null}
              <T numberOfLines={1} style={[{ fontSize: 12, lineHeight: 16, color: f.ink ?? C.muted }, weight(600)]}>
                {f.text}
              </T>
            </View>
          ))}
        </View>
      ) : null}

      {waitingLine ? (
        <T numberOfLines={2} style={[{ marginTop: 10, fontSize: 12, lineHeight: 17, color: C.warnInk }, weight(600)]}>
          {waitingLine}
        </T>
      ) : null}
      {pillWarning ? <WarnPill text={pillWarning} style={{ marginTop: 10 }} /> : null}
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
export function LeadsBook({
  seedQuery = '',
  frame,
}: {
  seedQuery?: string;
  /**
   * The Leads route draws the title, the count and the search row INSIDE its
   * lavender hero, as V3 does; the state lives here, so the route hands this
   * book its frame and the book fills both halves. Absent — the Customers
   * tab — the search row sits above the chips, under that tab's own hero.
   */
  frame?: (parts: { hero: React.ReactNode; body: React.ReactNode }) => React.ReactElement;
} = {}) {
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
  /* Whether "What you found in the shop" is open. A fill that lands there
     opens it, and a refusal about one of its fields opens it too. */
  const [detailsOpen, setDetailsOpen] = React.useState(false);
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
    setDetailsOpen(false);
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
    /* A retake replaces the first picture rather than adding to it: the old
       one is taken out of the upload queue, or it would go up anyway with no
       lead ever bound to it. */
    if (shopPhotoId) void discardQueuedMedia(shopPhotoId);
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
    if (fillTouchesDetails(fill)) setDetailsOpen(true);
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

  const detailsCount = answeredDetails({
    gstin,
    potential,
    followUp,
    address,
    custType,
    litres,
    decisionMaker,
    competitor,
    shopPhotoId,
  });

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
    const gst = normaliseGstin(gstin);
    const gstWrong = gstinRefusal(gst);
    if (gstWrong) {
      setDetailsOpen(true);
      return refuse(gstWrong);
    }

    saving.current = true;
    try {
      const potentialPaise = paiseFromTyped(potential);
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
        estimatedPotentialPaise: potentialPaise > 0 ? potentialPaise : null,
        nextFollowUpDate: followUp,
        salesType,
        address,
        customerType: custType,
        requirement,
        monthlyVolumeLitres: parseDecimal(litres) || null,
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
  /* The search row: the box, the due filter (navy, lime clock) and the add
     button. In the Leads route it sits in the lavender hero, as V3 draws it;
     on the Customers tab it sits above the chips, under that tab's own hero. */
  const searchRow = (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <SearchBox
        value={typed}
        onChange={setTyped}
        onClear={() => {
          setTyped('');
          setAsked('');
        }}
        placeholder="Name, shop, phone, city"
      />
      <ToolButton
        icon="clock"
        tone="navy"
        label={'Due: ' + whenLabel}
        on={when !== 'any'}
        onPress={() => setPickingWhen(true)}
      />
      <ToolButton icon="add" label="Add a lead" tone="primary" onPress={openForm} />
    </View>
  );
  const heroBlock = (
    <View style={{ marginTop: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text accessibilityRole="header" style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.5, color: HERO.lavender.ink }, weight(800)]}>
          Leads
        </Text>
        {loaded ? (
          <T style={[{ fontSize: 16, color: HERO.lavender.muted }, weight(700)]}>{grouped(total)}</T>
        ) : null}
      </View>
      <View style={{ marginTop: 12 }}>{searchRow}</View>
    </View>
  );
  const controls = (
    <View style={{ paddingHorizontal: 14, paddingTop: 14, gap: 10 }}>
      {frame ? null : searchRow}
      <ChipRow
        chips={LEAD_VIEWS}
        value={view}
        counts={viewCounts}
        onChange={(v) => {
          setView(v);
          /* A rung belongs to the band it was picked under; carried across,
             it would narrow the new band to a rung it does not carry. */
          setRung(null);
        }}
      />
      {rungs.length > 1 ? (
        <RungChips
          chips={rungChips}
          value={rung ?? '__all'}
          onChange={(v) => setRung(v === '__all' ? null : v)}
          counts={rungCounts}
        />
      ) : null}
      {/* A count under a search is a count of the MATCHES, and says so. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6 }}>
        <T numberOfLines={1} style={[{ flex: 1, minWidth: 0, fontSize: 13, color: C.muted }, weight(600)]}>
          {!loaded
            ? 'Reading your leads…'
            : total
              ? `${grouped(total)} ${total === 1 ? 'lead' : 'leads'}` + (asked ? ` · “${asked}”` : '')
              : 'No leads match'}
        </T>
        <Pressable
          onPress={() => setPickingWhen(true)}
          accessibilityRole="button"
          accessibilityLabel={'Show leads due: ' + whenLabel}
          hitSlop={8}
          style={({ pressed }) => ({
            height: 30,
            paddingHorizontal: 12,
            borderRadius: 15,
            backgroundColor: pressed ? C.wash : C.surface,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
          })}>
          <T numberOfLines={1} style={[{ fontSize: 12, color: when === 'any' ? C.primaryDeep : C.danger }, weight(700)]}>
            {when === 'any' ? 'Most urgent first' : whenLabel}
          </T>
          <View style={{ transform: [{ rotate: '90deg' }] }}>
            <Icon name="forward" size={13} color={when === 'any' ? C.primaryDeep : C.danger} strokeWidth={2.4} />
          </View>
        </Pressable>
      </View>
    </View>
  );

  const empty = React.useMemo(
    () => (
      <View
        style={{
          marginHorizontal: 14,
          paddingHorizontal: 16,
          paddingVertical: 18,
          borderRadius: 20,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: C.border,
        }}>
        <T style={[{ fontSize: 16, lineHeight: 21, color: C.ink, textAlign: 'center' }, weight(800)]}>
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
        <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, textAlign: 'center', marginTop: 4 }}>
          {asked
            ? 'Search looks at shop, person, number and town. Clear it to see all leads.'
            : when !== 'any'
            ? 'All leads are still here. This shows only pending work.'
            : view === 'all'
              ? 'Add a shop you visit or a name someone gives you.'
              : 'All leads are still under All. Nothing is deleted.'}
        </T>
      </View>
    ),
    [view, when, asked, loaded],
  );

  const body = (
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
        contentContainerStyle={{ paddingTop: 10, paddingBottom: 24 }}
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
        <View
          style={{
            marginHorizontal: -20,
            marginTop: -12,
            marginBottom: -24,
            paddingHorizontal: 14,
            paddingTop: 14,
            paddingBottom: 24,
            backgroundColor: C.canvas,
            gap: 12,
          }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>New lead</Text>
            <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>Number checked against your book</T>
          </View>
          {/* SPEAKING fills the whole form, so it is offered first, here and
              again as a sentence under the header. Not drawn where the office
              cannot hear or read; a button that fails is worse than none. */}
          {voiceOn ? (
            <RoundTool
              icon="mic"
              label="Speak about the shop"
              bg={voicing ? C.navy : C.primary}
              ink={voicing ? C.lime : '#FFFFFF'}
              on={voicing}
              onPress={() => {
                if (!voicing) setVoiceKey((k) => k + 1);
                setVoicing((v) => !v);
                setScanning(false);
              }}
            />
          ) : null}
          {/* THE SCAN, in the header rather than down the form: it fills the
              first six answers, so it is offered before any of them is typed.
              Not drawn at all where the office cannot read photos — a button
              that fails when pressed is worse than none. */}
          {scanCfg.available ? (
            <RoundTool
              icon="scan"
              label="Scan a visiting card or shop board"
              bg={scanning ? C.navy : C.surface}
              ink={scanning ? C.lime : C.ink}
              on={scanning}
              onPress={() => {
                if (!scanning) setScanKey((k) => k + 1);
                setScanning((v) => !v);
                setVoicing(false);
              }}
            />
          ) : null}
        </View>

        {/* SPEAKING, offered as a sentence as well as the mic: a mic glyph in
            a header reads as "voice typing into one box", which is a
            different promise from filling the whole form. */}
        {voiceOn && !voicing ? (
          <Pressable
            onPress={() => {
              setVoiceKey((k) => k + 1);
              setVoicing(true);
              setScanning(false);
            }}
            accessibilityRole="button"
            accessibilityLabel="Speak about the shop. Say everything, in any language. We fill the form for you to check."
            style={({ pressed }) => ({
              minHeight: 44,
              borderRadius: 22,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
            })}>
            <Icon name="spark" size={15} color={C.primaryDeep} strokeWidth={2} />
            <T style={[{ flex: 1, fontSize: 12, lineHeight: 16, color: C.primaryDeep }, weight(600)]}>
              Say it in any language · we fill the form for you to check
            </T>
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
            with a reason. Tiles rather than a dropdown: the sentence under
            each is what somebody standing outside a shop reads to choose.
            OFFERED, not all three: Mahek does not appoint distributors
            through MahekOne, so that ladder is withdrawn for new leads — the
            note on `SALES_TYPES` in the funnel engine has the whole of it. */}
        <LeadCard>
          <CardHead required>Kind of sale</CardHead>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {offeredSalesTypes().map((t) => {
              const on = salesType === t.code;
              return (
                <Pressable
                  key={t.code}
                  onPress={() => {
                    if (!on) feedback('select');
                    setSalesType(t.code);
                    setErr(null);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={t.label + '. ' + t.hint}
                  style={({ pressed }) => ({
                    flexGrow: 1,
                    flexBasis: '45%',
                    minHeight: 88,
                    borderRadius: 16,
                    borderWidth: on ? 2 : 1,
                    borderColor: on ? C.primary : C.border,
                    backgroundColor: on ? C.primaryTint : pressed ? C.wash : C.surface,
                    padding: on ? 11 : 12,
                  })}>
                  <Icon name={t.code === 'third_party' ? 'route' : t.code === 'distributor' ? 'people2' : 'shop'} size={20} color={on ? C.primaryDeep : C.muted} strokeWidth={2} />
                  <T style={[{ marginTop: 6, fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>{t.label}</T>
                  <T style={{ fontSize: 11, lineHeight: 15, color: C.muted }}>{t.hint}</T>
                </Pressable>
              );
            })}
          </View>
        </LeadCard>

        <LeadCard padded={false}>
          <FormRow
            icon="person"
            label="Who you spoke to"
            value={name}
            onChangeText={(v) => { setName(v); setErr(null); }}
            placeholder="Suresh Patil"
          />
          <FormRow icon="shop" label="Shop name" value={company} onChangeText={setCompany} placeholder="Patil Hardware & Paints" />
          <FormRow
            icon="call"
            label="Mobile"
            required
            value={mobile}
            onChangeText={(v) => { setMobile(v); setErr(null); setDup(null); }}
            placeholder="98220 11001"
            keyboardType="phone-pad"
          />
          <View style={{ borderBottomWidth: 1, borderBottomColor: C.hairline }}>
            {areas.kind === 'none' ? (
              <View style={{ paddingVertical: 12 }}>
                <WarnPill text="No area is set for you yet. You can add leads only in your own area. Ask the office to set one." />
              </View>
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
                  <FormRow
                    icon="pin"
                    label="City"
                    last
                    value={city}
                    onChangeText={setCity}
                    placeholder="Nagpur"
                  />
                )}
              </>
            )}
          </View>
          <FormRow
            icon="sample"
            label="What they want"
            last
            value={requirement}
            onChangeText={setRequirement}
            placeholder="Thinner for a spray booth"
          />
        </LeadCard>

        <LeadCard>
          <CardHead required>How you found them</CardHead>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {(sources ?? []).map((s) => (
              <WashChip key={s.code} label={s.label} on={source === s.code} onPress={() => setSource(s.code)} />
            ))}
          </View>
          {/* "Other" has to say where it came from — the web form asks the
              same, and an unexplained Other is the one bar nobody can read. */}
          {source === OTHER_SOURCE ? (
            <View style={{ marginTop: 10 }}>
              <BoxInput
                value={sourceDetail}
                onChangeText={(v) => { setSourceDetail(v); setErr(null); }}
                placeholder="Where it came from — a builder nearby sent him"
                accessibilityLabel="Source details"
              />
            </View>
          ) : null}
        </LeadCard>

        {/* ALL OPTIONAL, AND BEHIND ONE TAP. A salesman outside a closed shop
            with a name and a number must still be able to save, and a
            fourteen-field form is how you get fourteen empty fields. Closed,
            it says how many it already holds, so nothing filled is hidden
            without a word. */}
        <LeadCard style={{ paddingTop: 6, paddingBottom: detailsOpen ? 16 : 12 }}>
          <Pressable
            onPress={() => setDetailsOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsOpen }}
            accessibilityLabel={'What you found in the shop. ' + (detailsOpen ? 'All optional.' : detailsSummary(detailsCount))}
            style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="spark" size={18} color={C.primaryDeep} strokeWidth={2} />
            <T style={[{ flex: 1, fontSize: 15, color: C.ink }, weight(700)]}>Found in the shop</T>
            {detailsCount > 0 ? (
              <View style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: C.successBg, justifyContent: 'center' }}>
                <T style={[{ fontSize: 12, color: C.success }, weight(700)]}>{detailsCount + ' answered'}</T>
              </View>
            ) : null}
            <View style={{ transform: [{ rotate: detailsOpen ? '-90deg' : '90deg' }] }}>
              <Icon name="forward" size={18} color={C.muted} strokeWidth={2} />
            </View>
          </Pressable>
          <T style={{ fontSize: 11, lineHeight: 15, color: C.faint }}>
            {detailsOpen ? 'All optional. Save what you have. Add the rest later.' : detailsSummary(detailsCount)}
          </T>

          {detailsOpen ? (
            <View style={{ gap: 8, marginTop: 10 }}>
              <BoxInput
                tag="GST"
                value={gstin}
                onChangeText={(v) => { setGstin(v.toUpperCase()); setErr(null); }}
                placeholder="27AAPFU0939F1ZV"
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={20}
                accessibilityLabel="GST number, if they have one"
              />
              <T style={{ fontSize: 11, lineHeight: 15, color: C.faint, marginTop: -4 }}>If they have one. Needed later to qualify.</T>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  {/* In rupees, about. Empty where he does not know. */}
                  <BoxInput
                    icon="money"
                    suffix="₹/mo"
                    value={potential}
                    onChangeText={(v) => setPotential(cleanAmount(v))}
                    placeholder="40000"
                    keyboardType="decimal-pad"
                    accessibilityLabel="How much they can buy a month, in rupees"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  {/* LITRES, not cans. There is no pack size agreed yet — a shop
                      says "about two hundred litres" long before anybody knows
                      what they will buy it as. */}
                  <BoxInput
                    icon="sample"
                    suffix="L/mo"
                    value={litres}
                    onChangeText={(v) => setLitres(cleanDecimal(v, 2))}
                    placeholder="200"
                    keyboardType="decimal-pad"
                    accessibilityLabel="How much a month, in litres, as they say it"
                  />
                </View>
              </View>
              <Pressable
                onPress={() => setCal(true)}
                accessibilityRole="button"
                accessibilityLabel={'Next follow-up on: ' + (followUp ? dmy(followUp) : 'choose a day')}
                style={{
                  minHeight: 52,
                  borderWidth: 1,
                  borderColor: C.border,
                  borderRadius: 16,
                  backgroundColor: C.surface,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingHorizontal: 14,
                }}>
                <Icon name="cal" size={18} color={C.primaryDeep} strokeWidth={2} />
                <T style={{ flex: 1, fontSize: 15, color: followUp ? C.ink : C.faint }}>
                  {followUp ? pretty(followUp) : 'Choose a day'}
                </T>
                <T style={{ fontSize: 11, color: C.faint }}>next follow-up</T>
              </Pressable>
              <BoxInput
                icon="pin"
                value={address}
                onChangeText={setAddress}
                placeholder="Shop 4, Itwari Market, near the bus stand"
                accessibilityLabel="Where the shop is"
              />
              <T style={[{ fontSize: 12, color: C.ink, marginTop: 4 }, weight(700)]}>Kind of business</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {CUSTOMER_TYPES.map((t) => (
                  <WashChip
                    key={t.value}
                    label={t.label}
                    on={custType === t.value}
                    onPress={() => setCustType(custType === t.value ? null : t.value)}
                  />
                ))}
              </View>
              <BoxInput
                icon="person"
                value={decisionMaker}
                onChangeText={setDecisionMaker}
                placeholder="Who decides · if not him"
                accessibilityLabel="Who decides, if that is not the person you spoke to"
              />
              <BoxInput
                icon="shop"
                suffix="buys from now"
                value={competitor}
                onChangeText={setCompetitor}
                placeholder="Asian Paints"
                accessibilityLabel="Who they buy from now"
              />
              <Pressable
                onPress={shootShop}
                accessibilityRole="button"
                accessibilityLabel={shopPhotoId ? 'Shop photo taken. Retake it' : 'Take a shop photo'}
                style={({ pressed }) => ({
                  minHeight: 52,
                  borderRadius: 16,
                  borderWidth: 1.5,
                  borderStyle: 'dashed',
                  borderColor: '#B9A6FF',
                  backgroundColor: pressed ? C.primaryTint : '#F7F4FF',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                })}>
                <Icon name={shopPhotoId ? 'tick' : 'camera'} size={18} color={C.primaryDeep} strokeWidth={2} />
                <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(700)]}>
                  {shopPhotoId ? 'Photo taken · retake' : 'Shop photo'}
                </T>
              </Pressable>
            </View>
          ) : null}
        </LeadCard>

        <Presence show={!!err}>
          <Animated.View
            style={[{ backgroundColor: C.dangerBg, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14 }, refusal.style]}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Icon name="warn" size={18} color={C.danger} strokeWidth={2.2} />
              <T style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.danger }, weight(600)]}>{err}</T>
            </View>
            {dup ? (
              <PillButton
                label={dup.kind === 'customer' ? 'Open ' + dup.name : 'Open the lead'}
                variant="white"
                height={44}
                onPress={openDuplicate}
                style={{ marginTop: 10 }}
              />
            ) : null}
          </Animated.View>
        </Presence>

        {/* Closing the sheet any other way — the scrim, the back gesture —
            keeps what he typed and brings it straight back. Cancel is the one
            gesture that means throw it away, so it is the one that clears. */}
        <Text
          accessibilityLabel="If you close this by mistake, your typing is kept. Cancel deletes it."
          style={[{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center' }, weight(400)]}>
          Closing keeps your typing · Cancel deletes it
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Pressable
            onPress={() => {
              setFormOpen(false);
              clearForm();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel and delete what you typed"
            style={({ pressed }) => ({
              width: 110,
              height: 60,
              borderRadius: 30,
              backgroundColor: pressed ? C.wash : C.surface,
              alignItems: 'center',
              justifyContent: 'center',
            })}>
            <T style={[{ fontSize: 15, color: C.danger }, weight(700)]}>Cancel</T>
          </Pressable>
          <PillButton label="Add lead" variant="navy" height={60} onPress={save} style={{ flex: 1 }} />
        </View>
        </View>
        )}
      </BottomSheet>

      {/* -------------------------------------------------------- when owed */}
      <BottomSheet open={pickingWhen} onClose={() => setPickingWhen(false)}>
        <Text accessibilityRole="header" style={[{ fontSize: 18, lineHeight: 23, color: C.ink, marginBottom: 10 }, weight(800)]}>
          Show leads due
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {LEAD_WHENS.map((w) => {
            const on = when === w.value;
            const late = w.value === 'overdue';
            return (
              <Pressable
                key={w.value}
                onPress={() => {
                  if (!on) feedback('select');
                  setWhen(w.value);
                  setPickingWhen(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={w.label}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: 16,
                  borderRadius: 22,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: on ? (late ? C.danger : C.navy) : pressed ? C.hairline : C.canvas,
                })}>
                {on ? <Icon name={late ? 'warn' : 'tick'} size={14} color={'#FFFFFF'} strokeWidth={2.4} /> : null}
                <T style={[{ fontSize: 14, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>{w.label}</T>
              </Pressable>
            );
          })}
        </View>
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
  return frame ? frame({ hero: heroBlock, body }) : body;
}

/**
 * The rungs under a picked band, V3's second row: smaller pills, the chosen
 * one in the brand's edge colour so it never reads as the band chip above.
 */
function RungChips({
  chips,
  value,
  onChange,
  counts,
}: {
  chips: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  counts: Record<string, number>;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ marginHorizontal: -14, flexGrow: 0 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 14, paddingVertical: 2 }}>
      {chips.map((c) => {
        const on = c.value === value;
        const n = counts[c.value];
        return (
          <Pressable
            key={c.value}
            onPress={() => {
              if (!on) feedback('select');
              onChange(c.value);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={n != null ? `${c.label}, ${n}` : c.label}
            hitSlop={{ top: 8, bottom: 8 }}
            style={{
              height: 30,
              paddingHorizontal: 12,
              borderRadius: 15,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? C.primaryEdge : C.surface,
            }}>
            <T style={[{ fontSize: 12, color: on ? C.lavenderInk : C.ink }, weight(on ? 700 : 600)]}>
              {c.label + (n != null ? ' ' + grouped(n) : '')}
            </T>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A 44 round button in the form's header — speak, scan. */
function RoundTool({
  icon,
  label,
  bg,
  ink,
  on,
  onPress,
}: {
  icon: 'mic' | 'scan';
  label: string;
  bg: string;
  ink: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.85 : 1,
      })}>
      <Icon name={icon} size={20} color={ink} strokeWidth={2} />
    </Pressable>
  );
}
