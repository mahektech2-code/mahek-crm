import React from 'react';
import { Animated, Image, Text, View, Pressable, ScrollView } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { PillButton } from '../src/components/ui/v3';
import { SearchBox } from '../src/components/ui/book-controls';
import { LeadCard, LeadGlyph, SheetChip, StagePill, STAGE_PILL, WarnPill, WashInput } from '../src/components/leads/v3-parts';
import { PrimaryButton, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { CommitmentCard } from '../src/components/leads/commitment-card';
import { CommitmentSheet } from '../src/components/leads/commitment-sheet';
import { NextActionSheet } from '../src/components/leads/next-action-sheet';
import { RelationshipChain } from '../src/components/leads/relationship-chain';
import { ReasonSheet } from '../src/components/leads/reason-sheet';
import { color as C, weight, type BadgeTone } from '../src/theme/tokens';
import {
  ensureLeadShop,
  leadCreateRefused,
  leadThresholds,
  leadVisitRefusal,
  setArchived,
  shopThatRefusedLead,
  touchLead,
  type Lead,
} from '../src/data/leads';
import { validationsFor, verificationChecksFor, type VerificationCheck } from '../src/data/validations';
import { FieldCheckNote, checksByField, valueFromChecks } from '../src/components/leads/field-check-note';
import { CommunicationPanel } from '../src/components/leads/communication-panel';
import {
  communicationLog,
  recordCommunication,
  type CommunicationLog,
} from '../src/data/lead-communication';
import { callNumber } from '../src/lib/messaging';
import {
  addLeadNote,
  advanceStage,
  decideSuspect,
  distributorCandidates,
  leadEvents,
  leadFunnelView,
  markLost,
  putOnHold,
  recordExpectedOrder,
  setLeadParties,
  setNextAction,
  setSalesType,
  shopPhoto,
  type LeadEvent,
  type LeadFunnelView,
} from '../src/data/lead-funnel';
import { currentSession } from '../src/data/session';
import { gateAsRun, leadAlert, type DuplicateMatch, type LeadThresholds } from '../src/engines/leads';
import {
  bandOf,
  findingLabel,
  gateTo,
  isParked,
  isTerminal,
  labelOf,
  ladderFor,
  offeredSalesTypes,
  PROSPECT_CONDITIONS,
  REASON_CODE_NEEDING_REMARKS,
  salesTypeLabel,
  stageLabel,
  stageSentence,
  VERIFICATION_COLUMNS,
  VERIFICATION_QUESTIONS,
  type LeadSalesType,
  type LeadStage,
} from '../src/engines/funnel';
import { compactInrFromPaise, dmy, hhmm, inrFromPaise, isoDate, plural, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { Appear, Pop, Presence, Stagger, useShake } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';

/**
 * One lead, on its own ladder.
 *
 * The whole of §28 is on this screen and it is drawn one way round rather than
 * the other: the next rung is always THERE, and where it cannot be taken it is
 * disabled with the conditions still missing listed underneath it. A control
 * that is absent teaches nothing — a salesman concludes the app is broken or
 * that the rung does not exist — and one that says what it wants teaches him
 * the process a step at a time. The list under the button is the same
 * `Condition[]` the server action refuses on, in the same words, because both
 * sides compile `engines/funnel`.
 *
 * The one place that is not a gate is the suspect window (§4). Past the
 * configured number of visits the record becomes ONE question with nothing
 * else on it, because nothing is being refused there — something is being
 * demanded, and a screen that let him carry on noting things down would be the
 * app helping him avoid the decision.
 */

/*
 * The badge's colour comes off the SAME rung its words do. It was keyed on the
 * six-word column while the text came from the funnel stage, so a lead at
 * Sample/Trial — stored there as `Qualified` — and one at First order —
 * stored as `Negotiation` — could read one rung and wear another's colour.
 * The four funnel bands decide it, and the three places a lead leaves the
 * funnel are named rather than guessed.
 */
function stageTone(stage: LeadStage): BadgeTone {
  if (stage === 'won' || stage === 'customer' || stage === 'active_distributor') return 'success';
  if (stage === 'lost') return 'danger';
  if (isParked(stage)) return 'neutral';
  switch (bandOf(stage)) {
    case 'new': return 'info';
    case 'contacted': return 'teal';
    case 'qualified':
    case 'negotiation': return 'amber';
    default: return 'neutral';
  }
}

/**
 * §4.1 — the manager's three, in a colour and a word.
 *
 * `high` is `danger` rather than `amber` deliberately: it is the one that has
 * to survive being glanced at beside a stage badge, and amber is already what a
 * blocked commitment and a parked lead use. `low` is drawn plainly — somebody
 * has judged it and said "not first", which is information, and colouring it
 * would make a screen of low-priority leads look like a screen of problems.
 */
const PRIORITY_TONE: Record<string, BadgeTone> = {
  high: 'danger',
  medium: 'amber',
  low: 'neutral',
};

/** The stored word, in one somebody would say. Anything unrecognised is drawn
    as it arrived rather than swallowed: a fourth value added at a desk should
    read as itself on an older handset, not vanish. */
function priorityWord(p: string): string {
  switch (p) {
    case 'high': return 'High priority';
    case 'medium': return 'Medium priority';
    case 'low': return 'Low priority';
    default: return p;
  }
}

export default function LeadRecord() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';
  const back = useCameFrom('leads');
  const notify = useStore((s) => s.notify);
  const set = useStore((s) => s.set);
  const arrival = useStore((s) => s.arrival);
  const askTravel = useStore((s) => s.askTravel);

  const [view, setView] = React.useState<LeadFunnelView | null>(null);
  const [events, setEvents] = React.useState<LeadEvent[]>([]);
  const [me, setMe] = React.useState<{ id: string; name: string } | null>(null);
  /* Null until the thresholds arrive from configuration. A default written in
     here would be a business rule living in a screen. */
  const [cfg, setCfg] = React.useState<LeadThresholds | null>(null);
  const [today] = React.useState(() => isoDate(new Date()));
  const [note, setNote] = React.useState('');

  /* the drawers — each keyed so it remounts fresh rather than being reset in
     an effect, which the React Compiler rules forbid */
  const [lost, setLost] = React.useState(false);
  const [suspect, setSuspect] = React.useState<'prospect' | 'not' | null>(null);
  const [nextOpen, setNextOpen] = React.useState(false);
  const [ladderOpen, setLadderOpen] = React.useState(false);
  const [parties, setParties] = React.useState(false);
  /* The rung picker a parked lead comes back on. Closed until he asks for it,
     because a list of twelve rungs on a record that is on hold reads as the
     screen suggesting he move it. */
  const [returning, setReturning] = React.useState(false);

  /*
   * THE LADDER MOVES WHEN HE MOVES IT, and only then.
   *
   * `moves` counts the rungs climbed from THIS screen. The rung he is standing
   * on is drawn inside a `Pop` that pops on mount only once he has moved —
   * opening a record half way up a ladder is not news, reaching the rung is.
   * A counter rather than a "just moved" flag, so nothing has to reset it.
   */
  const [moves, setMoves] = React.useState(0);
  /* The rung above, refused. The buzz is the shake's own: the sentence it
     answers with is the rung's description, an `info` toast that does not buzz,
     and the list of what is missing sits directly under the chips. */
  const rungRefusal = useShake('warning');
  /* Each refused tap re-pops the "still to do" card, which is what ties a
     shaking chip to the list that explains it. */
  const [refusals, setRefusals] = React.useState(0);

  /*
   * PARKING IS THREE QUESTIONS AND THEY ARE ASKED ONE AT A TIME.
   *
   * Why it stopped, the day it comes back, and what happens when it does —
   * none of them optional, because a park missing any one of the three is the
   * state the whole thing exists to prevent. They are three sheets rather than
   * one long form for the reason the rest of this app is built: each is a
   * question somebody can answer standing in a shop, and the two that already
   * have a component here — `ReasonSheet` and `NextActionSheet` — are the same
   * two questions the funnel asks everywhere else, in the same words.
   *
   * ONE piece of state and not three booleans. Three would let two sheets be
   * open at once and would let the second be reached with the first unanswered
   * — and what the second and third ask depends on what the first said, so the
   * answers travel WITH the step rather than in three fields that can be
   * cleared independently.
   */
  const [hold, setHold] = React.useState<
    | null
    | { step: 'why' }
    | { step: 'until'; code: string; note: string }
    | { step: 'next'; code: string; note: string; until: string }
  >(null);
  /*
   * A `ref` and not `useState`, and this is earned rather than stylistic: a
   * state flag is read from the closure of the render that drew the button, so
   * a second press landing before React has re-rendered sees the old `false`
   * and parks the lead twice. It has already cost this app duplicate visits,
   * complaints and samples.
   */
  const parking = React.useRef(false);

  const [commitOpen, setCommitOpen] = React.useState(false);
  /* A ref rather than state, for the reason `parking` beside it gives: a
     second press lands before React has re-rendered and records the promise
     twice. */
  const committing = React.useRef(false);

  const [checks, setChecks] = React.useState<Awaited<ReturnType<typeof validationsFor>>>([]);
  const [fieldChecks, setFieldChecks] = React.useState<VerificationCheck[]>([]);
  const [photo, setPhoto] = React.useState<{ uri: string | null } | null>(null);
  /* §10.4 — the eleven ways of reaching out, what each of them would send, and
     what has already gone. Null until the first read: an empty log and a log
     nobody has read yet are different things, and drawing eleven buttons all
     reading "nothing sent" over a record that has had six would be worse than
     drawing nothing for a moment. */
  const [comms, setComms] = React.useState<CommunicationLog | null>(null);
  /* The shop the office meant when it refused this lead as a duplicate, where
     it is on this phone — the refusal offers to open it. */
  const [existingShop, setExistingShop] = React.useState<DuplicateMatch | null>(null);

  const load = React.useCallback(() => {
    let live = true;
    if (!id) return;
    void Promise.all([
      leadFunnelView(id),
      leadEvents(id),
      leadThresholds(),
      currentSession(),
      /* §E — the office's own call to this shop. Recorded by `app/validate.tsx`
         and read back by nothing until now, so the one thing this call
         produces that nothing else could — the office's answer beside the
         salesman's — was written down and never shown to either of them. */
      validationsFor(id),
      /* §5.2 — WHO CHANGED WHAT ON THIS LEAD, AND WHY. The corrected values
         have always reached this phone, on the lead itself; the record of the
         correction reached it on no channel at all, so a figure a salesman
         answered for last week came back silently replaced. */
      verificationChecksFor(id),
      shopPhoto(id),
      communicationLog(id),
    ]).then(([v, e, t, s, calls, verifications, shot, reach]) => {
      if (!live) return;
      setView(v);
      setEvents(e);
      setCfg(t);
      setMe(s ? { id: s.user.id, name: s.user.name } : null);
      setChecks(calls);
      setFieldChecks(verifications);
      setPhoto(shot);
      setComms(reach);
      void shopThatRefusedLead(id, v?.lead.mobile ?? null).then((m) => {
        if (live) setExistingShop(m);
      });
    });
    return () => {
      live = false;
    };
  }, [id]);

  useFocusEffect(load);

  /* §4 — the decision screen REPLACES the record, so arriving on it is a
     refusal of everything else on the lead, said once as a buzz. Fired from an
     effect on the transition rather than on every render, and only once per
     time the screen takes over. */
  const mustDecideNow = Boolean(view?.mustDecide);
  const buzzedDecide = React.useRef(false);
  React.useEffect(() => {
    if (mustDecideNow && !buzzedDecide.current) feedback('warning');
    buzzedDecide.current = mustDecideNow;
  }, [mustDecideNow]);

  if (!view) {
    return (
      <AppFrame title="Lead" tone="lavender" activeTab={null} onBack={back.go} contentStyle={{ padding: 14, paddingBottom: 24 }}>
        <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 26, alignItems: 'center' }}>
          <Icon name="person" size={28} color={C.faint} strokeWidth={2} />
          <Text style={[{ fontSize: 16, lineHeight: 21, color: C.ink, textAlign: 'center', marginTop: 8 }, weight(800)]}>
            Not on this phone
          </Text>
          <Text
            accessibilityLabel="This lead is not on this phone. Go back to the list. Open it from there."
            style={[{ fontSize: 13, lineHeight: 19, color: C.muted, textAlign: 'center', marginTop: 4 }, weight(400)]}>
            Go back and open it from the list
          </Text>
        </View>
      </AppFrame>
    );
  }

  const { lead, salesType, stage, next, gate, mustDecide, visits, config, input } = view;
  /* `stageOf` folds the retired `won` onto `customer`, so the top of the ladder
     is where a won lead stands now — settled, with nothing left to climb. */
  const settled = stage === 'lost' || stage === 'won' || stage === 'customer' || stage === 'active_distributor';
  /* PARKED IS NEITHER, which is the whole reason `on_hold` exists: a stalled
     prospect folded into Lost is a live shop the staleness sweep archives. It
     is not on any ladder either, so there is no rung above it to offer — the
     gate says so and the screen has to say it in words. */
  const parked = isParked(stage);
  const title = lead.company?.trim() || lead.name;

  /* §A — WHAT HE LEARNED IN THE SHOP, read back.
     The capture sheet asks for these standing outside the shop and the record
     printed none of them, so seven optional fields went in and none came out —
     which is how a salesman learns not to fill them. Only what was actually
     answered is drawn: a column of "Not recorded" rows would be an invitation
     to fill boxes this screen has nowhere to open. */
  const learned: { label: string; value: string; finding?: string }[] = [];
  if (lead.address?.trim()) learned.push({ label: 'Where it is', value: lead.address.trim() });
  if (lead.requirement?.trim()) {
    learned.push({ label: 'What they want', value: lead.requirement.trim(), finding: 'required_product' });
  }
  const litres = lead.monthlyLitres ?? lead.monthlyVolumeLitres;
  if (litres != null) {
    learned.push({ label: 'Uses', value: plural(litres, 'litre') + ' a month', finding: 'monthly_litres' });
  }
  const onNow = lead.competitor?.trim() || lead.competitorName?.trim();
  if (onNow) learned.push({ label: 'Buys from now', value: onNow, finding: 'competitor' });

  /* §5.2 — EVERY CHECK IS BESIDE THE FIELD IT IS ABOUT, and that is what
     decides the shape of this list rather than a panel further down.
     A "Corrections" section under the timeline is one a salesman has to match
     against the values above it by eye, one field code at a time, standing in
     the shop the disagreement is about. Under the value there is nothing to
     match: what the record says and how it came to say it are one thing.

     Six of the nine findings have no line up there — who we ask for, who signs
     off, the credit they want and the rest — so a check on one of those would
     have nothing to sit under and would fall off the screen in silence. They
     get a line of their own, labelled in the finding's own words and carrying
     whatever the checks themselves say the value is. */
  const byFinding = checksByField(fieldChecks);
  const drawn = new Set(learned.map((l) => l.finding).filter(Boolean));
  for (const [field, rows] of byFinding) {
    if (drawn.has(field)) continue;
    learned.push({ label: findingLabel(field), value: valueFromChecks(rows) ?? '—', finding: field });
  }

  /*
   * §6 — THE YES IS GATED BEFORE THE SHEET OPENS, not after the reason is
   * typed. A Prospect is eight answers the office checks, and past the cap
   * this screen hides every other control — so a shut gate is said here, with
   * what it wants, and he is taken straight to the screen that asks for it.
   * The reason he is about to pick counts as given; it is the ninth answer.
   */
  const askProspect = () => {
    const verdict = gateAsRun(
      gateTo({ ...input, prospectReasonRecorded: true }, 'prospect'),
      input,
      config,
    );
    if (!verdict.open) {
      notify('Answer these first: ' + verdict.missing.map((c) => c.says).join('. ') + '.', 'warn');
      router.push(`/lead-prospect?id=${lead.id}&from=lead`);
      return;
    }
    setSuspect('prospect');
  };

  /* --------------------------------------------------------- §4 the window
   *
   * Past the cap this is the entire screen. Not a banner over the record and
   * not a disabled button: the specification forces the decision, and a
   * salesman who can still add a note and set a follow-up will do exactly that
   * for another three weeks.
   */
  if (mustDecide) {
    const cap = config.suspectMaxVisits;
    return (
      <AppFrame
        title="Lead"
        tone="navy"
        showTitle={false}
        activeTab={null}
        onBack={back.go}
        contentStyle={{ padding: 14, paddingBottom: 24 }}
        hero={
          <Appear>
            <View style={{ marginTop: 18 }}>
              <Text accessibilityRole="header" style={[{ fontSize: 24, lineHeight: 30, letterSpacing: -0.5, color: '#FFFFFF' }, weight(800)]}>
                {title}
              </Text>
              <Text style={[{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted, marginTop: 4 }, weight(400)]}>
                {[lead.city, lead.mobile].filter(Boolean).join(' · ')}
              </Text>
              <View
                accessible
                accessibilityLabel={'You have visited ' + plural(visits, 'time') + '.'}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18 }}>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {Array.from({ length: Math.max(1, Math.min(cap, 8)) }, (_, i) => (
                    <View
                      key={i}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        backgroundColor: i < visits ? C.lime : C.navySoft,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                      <Icon name="visit" size={16} color={i < visits ? C.navy : C.onNavyMuted} strokeWidth={2} />
                    </View>
                  ))}
                </View>
                <Text style={[{ fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(700)]}>{visits + ' of ' + cap + ' visits'}</Text>
              </View>
              <Text style={[{ fontSize: 20, lineHeight: 26, color: '#FFFFFF', marginTop: 18 }, weight(800)]}>
                Keep visiting?
              </Text>
              <Text
                accessibilityLabel={'You have visited ' + plural(visits, 'time') + '. Should you keep visiting? A Suspect gets ' + cap + ' visits. This one has had them all. Answer this first. Nothing else works until you do.'}
                style={[{ fontSize: 13, lineHeight: 19, color: C.onNavyMuted, marginTop: 4 }, weight(400)]}>
                {'A Suspect gets ' + cap + ' visits. Answer first, nothing else works until you do.'}
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                <PillButton label="Yes, Prospect" a11y="Yes, make it a Prospect" variant="lime" height={56} onPress={askProspect} style={{ flex: 1 }} />
                <Pressable
                  onPress={() => setSuspect('not')}
                  accessibilityRole="button"
                  accessibilityLabel="No, not a Prospect"
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: 56,
                    paddingVertical: 8,
                    borderRadius: 28,
                    backgroundColor: pressed ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.12)',
                    alignItems: 'center',
                    justifyContent: 'center',
                  })}>
                  <Text style={[{ fontSize: 15, lineHeight: 21, color: '#FFFFFF' }, weight(700)]}>No, not one</Text>
                </Pressable>
              </View>
            </View>
          </Appear>
        }>
        {suspectSheet()}
      </AppFrame>
    );
  }

  /* ------------------------------------------------------------- the moves */

  const move = async (to: LeadStage) => {
    const r = await advanceStage(lead.id, to);
    if (!r.ok) return notify(r.message, 'warn');
    /* Counted before the reload lands, so the rung that mounts under the new
       stage pops. The `success` toast below is the buzz; none is added. */
    setMoves((m) => m + 1);
    load();
    notify(stageLabel(to));
  };

  const saveNote = async () => {
    const r = await addLeadNote(lead.id, note);
    if (!r.ok) return notify(r.message, 'warn');
    setNote('');
    load();
    notify('Noted');
  };

  /* §9 §10 — the sample is gated on the twelve, same as everything else. */
  const sampleGate = gateTo(input, 'sample_trial');
  const alert = cfg ? leadAlert(lead, today, cfg) : null;
  const ladder = ladderFor(salesType);

  const refused = lead.syncState === 'rejected' || lead.syncState === 'blocked';
  const visitRefusal = leadVisitRefusal(lead);
  const startLeadVisit = async () => {
    if (visitRefusal) return notify(visitRefusal, 'warn');
    /* The row's own state is reset by any edit since; the outbox keeps the office's answer. */
    if (await leadCreateRefused(lead.id)) return notify(leadVisitRefusal({ archived: 0, syncState: 'rejected' }) ?? 'The office did not take this lead.', 'warn');
    if (arrival && arrival.checkedInAt == null) return notify(`Check in at ${arrival.customerName} first. You reached there at ${hhmm(arrival.arrivedAt)}.`, 'error');
    if (arrival && arrival.checkedInAt != null) return notify(`Check out of ${arrival.customerName} first. You are still in that visit.`, 'error');
    /* A lead created before this build has no shop row on the phone yet. */
    await ensureLeadShop({ id: lead.id, name: lead.name, company: lead.company, mobile: lead.mobile, city: lead.city, area: null, customerType: lead.customerType, gpsLat: lead.gpsLat, gpsLng: lead.gpsLng });
    set({ custId: lead.id });
    askTravel({ customerId: lead.id, customerName: title });
  };
  const hero = (
    <View style={{ marginTop: 16 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <HeroTag tone={stageTone(stage)} text={stageLabel(stage)} />
        {/* §4.1 — HOW HARD TO PUSH, and it is READ-ONLY on this phone.
            It is the manager's judgement about the WORK — which of forty
            leads to get to first — as against the potential below, which is
            a judgement about the account. A priority the person being
            measured could set himself would follow whatever he felt like
            doing, which is why `lead.verify` gates it and why there is no
            control here. Null is nobody having judged it and is NOT the same
            as low, so nothing is drawn at all. */}
        {lead.priority ? (
          <HeroTag
            tone={PRIORITY_TONE[lead.priority] ?? 'neutral'}
            text={priorityWord(lead.priority).replace(/ priority$/, '')}
            a11y={priorityWord(lead.priority)}
            flag={lead.priority === 'high'}
          />
        ) : null}
        <HeroTag tone="white" text={salesTypeLabel(salesType)} a11y={'Kind of sale: ' + salesTypeLabel(salesType)} />
      </View>
      <Text accessibilityRole="header" style={[{ marginTop: 10, fontSize: 26, lineHeight: 34, letterSpacing: -0.5, color: HERO.lavender.ink }, weight(800)]}>
        {title}
      </Text>
      <Text style={[{ marginTop: 4, fontSize: 13, lineHeight: 18, color: HERO.lavender.muted }, weight(400)]}>{stageSentence(stage)}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 }}>
          {lead.company?.trim() && lead.name ? <HeroFact icon="person" text={lead.name} /> : null}
          {lead.city ? <HeroFact icon="pin" text={lead.city} /> : null}
          <HeroFact text={lead.mobile ?? 'Mobile not taken'} />
          {lead.source ? <HeroFact text={lead.source} /> : null}
        </View>
        {/* THE NUMBER IS DIALLABLE. A lead is a shop nobody has sold to yet,
            so ringing them is most of the work. Ringing is also the one thing
            `touchLead` was written for: staleness, the archive prompt and the
            untouched-lead escalation all measure from `lastActivityDate`, so
            a lead worked hardest by phone must not be the one the app decides
            has been abandoned. Bumped on a placed call — the handset cannot
            tell whether they picked up. */}
        {lead.mobile ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={'Call ' + title}
            onPress={() => {
              void callNumber(lead.mobile!).then((out) => {
                if (out.status === 'failed') return notify(out.reason, 'warn');
                void touchLead(lead.id, today).then(load);
              });
            }}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: pressed ? C.primaryDeep : C.primary,
              alignItems: 'center',
              justifyContent: 'center',
            })}>
            <Icon name="call" size={20} color="#FFFFFF" strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  /* The facts that are not always there — the lead going quiet, why it is
     lost or waiting, where it stands against the visit cap, where it came
     from — as one row of chips rather than lines down a card. */
  const chips: React.ReactNode[] = [];
  if (alert) chips.push(<WarnPill key="alert" text={alert} />);
  if (stage === 'lost' && lead.lostReason) chips.push(<WarnPill key="lost" tone="danger" text={'Lost: ' + lead.lostReason} />);
  /* Why it is not moving. One column answers two questions — "what is this
     on hold for" and "why is this still a Suspect" — so it is drawn for
     both; a parked lead gets it from the stage card instead. */
  if (lead.holdReason && !parked) chips.push(<WarnPill key="wait" text={'Waiting: ' + lead.holdReason} />);
  /* §4 — visits one and two just say where he is up to. */
  if (stage === 'suspect' && !lead.suspectDecidedAt) {
    chips.push(
      <View
        key="cap"
        accessible
        accessibilityLabel={'Visit ' + Math.max(1, visits) + ' of ' + config.suspectMaxVisits + '. Decide by then if this is a Prospect.'}>
        <WarnPill text={'Visit ' + Math.max(1, visits) + ' of ' + config.suspectMaxVisits + ' · decide by then'} />
      </View>,
    );
  }
  /* Where it actually came from, in more words than "manual" — which
     exhibition, whose referral. Drawn only where there is one. */
  if (lead.sourceDetail?.trim()) {
    chips.push(<InfoChip key="from" text={'Came from: ' + lead.sourceDetail.trim()} />);
  }
  if (lead.convertedCustomerId) {
    chips.push(
      <InfoChip
        key="cust"
        text="Open the customer"
        icon="shop"
        onPress={() => {
          set({ custId: lead.convertedCustomerId ?? '', pTab: 0 });
          router.push('/customer');
        }}
      />,
    );
  }

  const ladderAt = ladder.indexOf(stage);

  return (
    <AppFrame
      title="Lead"
      tone="lavender"
      showTitle={false}
      hero={hero}
      activeTab={null}
      onBack={back.go}
      contentStyle={{ padding: 14, paddingBottom: 24, gap: 12 }}>
      {/* Refused by the office — most often because the shop was already on
          the book. Said at the top, because a note or a visit added below a
          record the office never took goes nowhere. */}
      {refused ? (
        <View style={{ backgroundColor: C.dangerBg, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="warn" size={20} color={C.danger} strokeWidth={2.2} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[{ fontSize: 14, lineHeight: 19, color: C.danger }, weight(700)]}>Office did not accept this lead</Text>
            <Text style={[{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.danger }, weight(400)]}>
              {existingShop
                ? `This number is already ${existingShop.name}. Work that one — anything you add here will not reach them.`
                : 'Anything you add here will not reach them. See why on Not accepted.'}
            </Text>
            {existingShop ? (
              <Pressable
                onPress={() => {
                  if (existingShop.kind === 'customer') {
                    set({ custId: existingShop.id, pTab: 0 });
                    router.push('/customer');
                  } else {
                    router.push(`/lead?id=${existingShop.id}&from=lead`);
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel={'Open the existing shop, ' + existingShop.name}
                hitSlop={6}
                style={({ pressed }) => ({ alignSelf: 'flex-start', marginTop: 8, minHeight: 36, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 18, backgroundColor: pressed ? C.wash : C.surface, justifyContent: 'center' })}>
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(700)]}>{'Open ' + existingShop.name}</Text>
              </Pressable>
            ) : null}
          </View>
          <Pressable
            onPress={() => router.push('/rejections?from=leads')}
            accessibilityRole="button"
            accessibilityLabel="Open Not accepted"
            hitSlop={6}
            style={({ pressed }) => ({ minHeight: 36, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 18, backgroundColor: pressed ? C.wash : C.surface, justifyContent: 'center' })}>
            <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(700)]}>Open</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ------------------------------------------------- visit the shop --

          A lead is a shop he walks into, and this screen had no way in: the
          only door to a visit was the customer card, which a lead added on
          this phone did not have until a sync had gone both ways. The same
          rules as the quick action — one shop and one visit at a time — and
          the same question about how he is getting there (`TravelGate`). */}
      {!lead.convertedCustomerId ? (
        <PrimaryButton
          label="Start visit"
          disabled={!!visitRefusal}
          whyDisabled={visitRefusal ?? undefined}
          onPress={() => void startLeadVisit()}
        />
      ) : null}

      {/* ---------------------------------------------------- the figures */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <StatTile
          icon="money"
          value={lead.estimatedPotentialPaise ? compactInrFromPaise(lead.estimatedPotentialPaise) : '—'}
          sub={lead.estimatedPotentialPaise ? 'a month' : 'not estimated'}
          a11y={'Can buy: ' + (lead.estimatedPotentialPaise ? inrFromPaise(lead.estimatedPotentialPaise) + ' a month' : 'Not estimated')}
        />
        <StatTile icon="visit" value={String(visits)} sub={visits === 1 ? 'visit' : 'visits'} a11y={'Visits: ' + plural(visits, 'visit')} />
        <StatTile
          icon="cal"
          value={lead.nextFollowUpDate ? dmy(lead.nextFollowUpDate) : 'None'}
          sub="follow-up"
          a11y={'Next follow-up: ' + (lead.nextFollowUpDate ? pretty(lead.nextFollowUpDate) : 'None set')}
        />
      </View>

      {chips.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{chips}</View> : null}

      {/* ------------------------------- §A what he learned in the shop --

          Written on the capture sheet outside the shop and shown nowhere
          afterwards — the address, what they want, what they get through, who
          they buy from now and the photograph of the shop front. Seven
          optional fields went in and none of them came out, so the next visit
          started from nothing and he stopped filling them in. */}
      {learned.length > 0 || lead.shopPhotoId ? (
        <LeadCard style={{ borderRadius: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="shop" size={18} color={C.ink} strokeWidth={2} />
            <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>Found in the shop</Text>
          </View>
          {lead.shopPhotoId ? (
            <View style={{ marginTop: 12 }}>
              {photo?.uri ? (
                <Image
                  source={{ uri: photo.uri }}
                  style={{ width: '100%', height: 140, borderRadius: 16, backgroundColor: C.border }}
                  resizeMode="cover"
                  accessibilityLabel={'The front of ' + title}
                />
              ) : (
                /* A photograph that has synced is no longer on this phone.
                   Saying so is the honest answer; an `<Image>` at a path that
                   no longer exists is a grey rectangle that explains nothing. */
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>
                  Shop photo taken. It was sent to the office. It is not on this phone now.
                </Text>
              )}
            </View>
          ) : null}
          {learned.length > 0 ? (
            <View style={{ gap: 10, marginTop: 12 }}>
              {learned.map((l) => (
                <View key={l.label} style={{ flexDirection: 'row', gap: 10 }} accessible accessibilityLabel={l.label + ': ' + l.value}>
                  <LearnedIcon label={l.label} finding={l.finding} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(400)]}>{l.value}</Text>
                    {/* Under the value, never in a list of its own — see
                        `field-check-note.tsx`. A field nobody has checked
                        draws nothing at all, which is the ordinary case. */}
                    <FieldCheckNote checks={l.finding ? (byFinding.get(l.finding) ?? []) : []} />
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </LeadCard>
      ) : null}

      {/* ------------------------------------------------- §3 the ladder */}
      {settled ? null : next || !parked ? (
        <LeadCard style={{ borderRadius: 22 }}>
          <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>Stage</Text>
          {/* How far up the ladder, one bar a rung: the filled ones are the
              rungs climbed, and the bar he reaches pops when he climbs one. */}
          {ladderAt >= 0 ? (
            <View
              accessible
              accessibilityLabel={'Stage ' + (ladderAt + 1) + ' of ' + ladder.length}
              style={{ flexDirection: 'row', gap: 4, marginTop: 12 }}>
              {ladder.map((rung, i) => (
                <View key={rung} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= ladderAt ? C.primary : C.border }} />
              ))}
            </View>
          ) : null}
          {/* Every rung of THIS lead's ladder, not a hardcoded six. A salesman
              learns the process from seeing what is above him, which is why
              the whole ladder is drawn rather than only the next step. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6, paddingVertical: 2, paddingHorizontal: 16 }}
            style={{ marginHorizontal: -16, marginTop: 10 }}>
            {ladder.map((rung) => {
              const shut = rung === next && !gate.open;
              const chip = (
                <RungChip
                  label={stageLabel(rung)}
                  on={rung === stage}
                  locked={shut}
                  onPress={() => {
                    /* Tapping the shut rung above shakes it and pops the
                       list under the button, so "why not" is answered where
                       he is looking. */
                    if (shut) {
                      rungRefusal.shake();
                      setRefusals((n) => n + 1);
                    }
                    notify(stageSentence(rung), 'info');
                  }}
                />
              );
              /* The wrapper is a remount: the rung he is on pops when he has
                 just reached it, the shut rung above can shake, every other
                 rung is plain. */
              if (rung === stage) {
                return (
                  <Pop key={rung + ':here'} trigger={stage} popOnMount={moves > 0} from={0.8}>
                    {chip}
                  </Pop>
                );
              }
              if (shut) {
                return (
                  <Animated.View key={rung + ':shut'} style={rungRefusal.style}>
                    {chip}
                  </Animated.View>
                );
              }
              return <View key={rung}>{chip}</View>;
            })}
          </ScrollView>

          {/* ------------------------------------------------- §28 the gate */}
          {next ? (
            <>
              {/* In and out rather than snapping: the list goes the moment
                  the last condition is answered. */}
              <Presence show={!gate.open}>
                <Pop trigger={refusals} from={0.94}>
                  <View style={{ marginTop: 12, backgroundColor: C.warnBg, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 }}>
                    <Text style={[{ fontSize: 12, lineHeight: 17, color: C.warnInk }, weight(700)]}>{'Before ' + stageLabel(next)}</Text>
                    {gate.missing.map((c, i) => (
                      <Stagger key={c.id} index={i}>
                        <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: i ? 4 : 6 }, weight(400)]}>
                          {'• ' + c.says}
                        </Text>
                      </Stagger>
                    ))}
                  </View>
                </Pop>
              </Presence>
              <PrimaryButton
                label={'Move up to ' + stageLabel(next)}
                disabled={!gate.open}
                whyDisabled={
                  gate.open
                    ? undefined
                    : 'Still to do: ' + gate.missing.map((c) => c.says.toLowerCase()).join(', ')
                }
                onPress={() => {
                  if (!gate.open) {
                    setRefusals((n) => n + 1);
                    return notify(gate.missing[0]?.says ?? 'Something is still missing.', 'warn');
                  }
                  void move(next);
                }}
                style={{ marginTop: 12, minHeight: 52, borderRadius: 26 }}
              />
            </>
          ) : (
            <View style={{ marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="tick" size={18} color={C.muted} strokeWidth={2} />
              <Text style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.muted }, weight(400)]}>
                This is the last stage. There is no stage after this.
              </Text>
            </View>
          )}
        </LeadCard>
      ) : (
        /* PARKED. There is no rung above a parked lead because it is standing
           on none: `on_hold` displaces the rung it was on, so the gate refuses
           to guess and this says so rather than offering the foot of the
           ladder. Coming back is a move to a NAMED rung, and the gate is asked
           about that rung exactly as it would be on any other move. */
        <LeadCard style={{ borderRadius: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.warnBg, alignItems: 'center', justifyContent: 'center' }}>
              <LeadGlyph name="pause" size={18} color={C.warnInk} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text accessibilityRole="header" style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(800)]}>On hold</Text>
              <Text style={[{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>Not lost · parked</Text>
            </View>
            <StagePill tone="amber" text="Parked" />
          </View>
          <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 12 }, weight(400)]}>
            {lead.holdReason
              ? 'Waiting: ' + lead.holdReason
              : lead.holdReasonCode
                ? 'Waiting: ' + labelOf(config.holdReasons, lead.holdReasonCode)
                : 'No reason was written for the hold.'}
          </Text>
          {/* THE CODE AS WELL AS THE SENTENCE, where there are both — the
              coded answer is the one that can be counted. Resolved from the
              configured list, never printed raw. */}
          {lead.holdReasonCode && lead.holdReason ? (
            <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(400)]}>{labelOf(config.holdReasons, lead.holdReasonCode)}</Text>
          ) : null}
          {/* WHEN IT COMES BACK, beside the reason it started. The office's
              own resume date wins where it has one; otherwise the follow-up
              date `putOnHold` fills in from the same answer. */}
          {lead.holdResumeDate ?? lead.nextFollowUpDate ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
              <Icon name="cal" size={16} color={(lead.holdResumeDate ?? lead.nextFollowUpDate!) <= today ? C.danger : C.ink} strokeWidth={2} />
              <Text style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: (lead.holdResumeDate ?? lead.nextFollowUpDate!) <= today ? C.danger : C.ink }, weight(700)]}>
                {(lead.holdResumeDate ?? lead.nextFollowUpDate!) <= today
                  ? 'It was due back on ' + dmy(lead.holdResumeDate ?? lead.nextFollowUpDate!) + '. Work on it now.'
                  : 'Back on ' + dmy(lead.holdResumeDate ?? lead.nextFollowUpDate!)}
              </Text>
            </View>
          ) : (
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.warnInk, marginTop: 10 }, weight(600)]}>
              No return day was set. It will not come back by itself.
            </Text>
          )}
          <Text style={[{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 6 }, weight(400)]}>
            It is not lost. To work on it again, choose the stage it goes back to.
          </Text>

          {returning ? (
            <>
              <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginTop: 14 }, weight(700)]}>Bring back to</Text>
              {/* The rungs it can be WORKED at. The end of the ladder is left
                  off: coming back off a hold is picking up where it stopped. */}
              <View style={{ gap: 8, marginTop: 8 }}>
                {ladder.filter((rung) => !isTerminal(rung)).map((rung) => (
                  <Pressable
                    key={rung}
                    onPress={() => {
                      setReturning(false);
                      void move(rung);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={'Bring it back to ' + stageLabel(rung) + '. ' + stageSentence(rung)}
                    style={({ pressed }) => ({ minHeight: 52, borderRadius: 16, backgroundColor: pressed ? C.hairline : C.canvas, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center' })}>
                    <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>{stageLabel(rung)}</Text>
                    <Text style={[{ fontSize: 12, lineHeight: 16, color: C.muted }, weight(400)]}>{stageSentence(rung)}</Text>
                  </Pressable>
                ))}
              </View>
              <PillButton label="Leave it on hold" variant="outline" height={48} onPress={() => setReturning(false)} style={{ marginTop: 10 }} />
            </>
          ) : (
            <PillButton label="Bring it back" variant="navyLime" height={52} onPress={() => setReturning(true)} style={{ marginTop: 14 }} />
          )}
        </LeadCard>
      )}

      {/* --------------------------------------------------- §24 next action */}
      {settled ? null : (
        <View style={{ backgroundColor: C.navy, borderRadius: 22, padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <LeadGlyph name="arrow" size={16} color={C.lime} />
            <Text accessibilityRole="header" style={[{ fontSize: 13, lineHeight: 18, color: C.lime }, weight(700)]}>Next</Text>
          </View>
          {lead.nextAction ? (
            <>
              <Text style={[{ fontSize: 16, lineHeight: 22, color: '#FFFFFF', marginTop: 8 }, weight(700)]}>{lead.nextAction}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, marginTop: 8 }}>
                {lead.nextActionDate ? (
                  <Text style={[{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted }, weight(400)]}>{pretty(lead.nextActionDate)}</Text>
                ) : null}
                <Text style={[{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted }, weight(400)]}>
                  {lead.nextActionOwnerId === me?.id ? 'You' : 'Your lead manager'}
                </Text>
              </View>
              {lead.nextActionOutcome ? (
                <Text style={[{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted, marginTop: 4 }, weight(400)]}>
                  {'Expecting: ' + lead.nextActionOutcome}
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={[{ fontSize: 15, lineHeight: 21, color: '#FFD98A', marginTop: 8 }, weight(600)]}>
              No action is pending on this lead. Set one, or it will be forgotten.
            </Text>
          )}
          <Pressable
            onPress={() => setNextOpen(true)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              marginTop: 12,
              minHeight: 44,
              paddingHorizontal: 16,
              borderRadius: 22,
              justifyContent: 'center',
              backgroundColor: lead.nextAction ? (pressed ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.12)') : C.lime,
            })}>
            <Text style={[{ fontSize: 13, lineHeight: 18, color: lead.nextAction ? '#FFFFFF' : C.navy }, weight(700)]}>
              {lead.nextAction ? 'Change it' : 'Set next action'}
            </Text>
          </Pressable>
        </View>
      )}

      {/* ------------------------------------------- §5.9 the chain --------

          Drawn only on a shop somebody else invoices, because that is the only
          shape it is true of. See `RelationshipChain`. The sales manager is
          the Lead Manager seat — the person the distributor's own side
          actually deals with, already on the row with its name beside its id,
          because this phone holds no user table to resolve one. */}
      {lead.thirdParty ? (
        <RelationshipChain
          shopName={title}
          distributorSalesmanName={lead.distributorSalesmanName}
          distributorName={lead.distributorName}
          distributorCount={lead.distributorCount}
          salesManagerName={lead.leadManagerName}
        />
      ) : null}

      {/* -------------------------------------------------------- the forms */}
      {settled ? null : (
        <>
          {/* §5.5 — THE COMMITMENT, and it sits at the TOP of the work. It is
              the one condition in front of `first_order` that is this
              salesman's to satisfy. Drawn only where the ladder he is on
              actually has that rung. */}
          {ladder.includes('first_order') ? (
            <CommitmentCard
              date={lead.expectedOrderDate}
              valuePaise={lead.expectedOrderValuePaise}
              quantityCans={lead.expectedOrderQuantityCans}
              blockerCode={lead.expectedOrderBlockerCode}
              blockers={config.orderBlockers}
              hasOrder={lead.hasOrder === 1}
              countingOrderCount={lead.countingOrderCount}
              today={today}
              onRecord={() => setCommitOpen(true)}
            />
          ) : null}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <WorkTile
              icon="note"
              label={'Prospect details · ' + PROSPECT_CONDITIONS.length}
              a11y={'Prospect details (' + plural(PROSPECT_CONDITIONS.length, 'question') + ')'}
              onPress={() => router.push(`/lead-prospect?id=${lead.id}&from=lead`)}
            />
            <WorkTile
              icon="task"
              label={salesType === 'distributor' ? 'Distributor qualification' : 'Qualification'}
              a11y={salesType === 'distributor' ? 'Distributor qualification (30 questions)' : 'Qualification checklist'}
              onPress={() => router.push(`/lead-qualify?id=${lead.id}&from=lead`)}
            />
            {/* §9 §10 — disabled until it is earned, and it names what is
                outstanding. A distributor's ladder has no sample rung, so there
                is no tile to draw — `sampleAsk` refuses the same case. */}
            {ladder.includes('sample_trial') ? (
              <WorkTile
                icon="sample"
                label="Request a sample"
                sub={sampleGate.open ? undefined : plural(sampleGate.missing.length, 'thing') + ' to answer first'}
                subTone="warn"
                locked={!sampleGate.open}
                a11y={
                  sampleGate.open
                    ? 'Request a sample'
                    : 'Request a sample. Still to do: ' + sampleGate.missing.map((c) => c.says.toLowerCase()).join(', ')
                }
                onPress={() => {
                  if (!sampleGate.open) {
                    feedback('warning');
                    return notify(sampleGate.missing[0]?.says ?? 'Not yet.', 'warn');
                  }
                  router.push(`/samples?lead=${lead.id}&ask=1&from=lead`);
                }}
              />
            ) : null}
            <WorkTile
              icon="people2"
              label={lead.thirdParty ? 'Billed by' : 'Who bills this shop'}
              sub={lead.thirdParty ? lead.distributorName ?? 'a distributor' : undefined}
              a11y={lead.thirdParty ? 'Billed by ' + (lead.distributorName ?? 'a distributor') : 'Who bills this shop'}
              onPress={() => setParties(true)}
            />
          </View>
          <Pressable
            onPress={() => setLadderOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={'Kind of sale: ' + salesTypeLabel(salesType) + '. Change it'}
            style={({ pressed }) => ({
              minHeight: 48,
              borderRadius: 24,
              borderWidth: 1.5,
              borderStyle: 'dashed',
              borderColor: '#B9A6FF',
              backgroundColor: pressed ? C.primaryTint : '#F7F4FF',
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 14,
            })}>
            <Text style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(700)]}>{'Kind of sale: ' + salesTypeLabel(salesType) + ' · change'}</Text>
          </Pressable>
        </>
      )}

      {/* ------------------------------------------------ §10.4 reaching out --

          Under the work and above the history: it is what he DOES between
          today and the day he goes back. Drawn only on a live lead — sending a
          price list to a shop written off last month is not a thing to make
          one tap away. Reaching out IS work on the lead, so it bumps
          `touchLead`, or a live shop ages into the staleness sweep. */}
      {settled || !comms ? null : (
        <CommunicationPanel
          log={comms}
          onDial={
            lead.mobile
              ? () => {
                  void callNumber(lead.mobile!).then((out) => {
                    if (out.status === 'failed') notify(out.reason, 'warn');
                  });
                }
              : undefined
          }
          onRecord={(args) => {
            void recordCommunication({ customerId: lead.id, ...args }).then((r) => {
              if (!r.ok) return notify(r.message, 'warn');
              void touchLead(lead.id, today).then(load);
            });
          }}
        />
      )}

      {/* The separate "Next follow-up on" picker that was here is gone.
          `setNextAction` already makes the next action's day the follow-up
          day, so the two were the same date set from two controls. */}

      {/* ---------------------------------------------- §E validation calls --

          The office rings the shop the working day after a lead is qualified
          and asks what the visit was actually like. `confirmedRequirement` is
          the point: what the office was told on the phone, kept apart from
          what the salesman was told standing in the shop, precisely so the two
          can disagree. The office's own calls arrive here too, under the same
          row id, which is what keeps a call made here from appearing twice.
          Where a figure disagrees with what he has, the disagreement is SAID. */}
      {checks.map((v) => {
        const tone: BadgeTone =
          v.verdict === 'confirmed'
            ? 'success'
            : v.verdict === 'not_qualified'
              ? 'danger'
              : v.verdict === 'on_hold'
                ? 'amber'
                : 'neutral';
        return (
          <LeadCard key={v.id} style={{ borderRadius: 22 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="call" size={18} color={C.ink} strokeWidth={2} />
              <Text accessibilityRole="header" style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>
                Office check call
              </Text>
              <StagePill tone={tone} text={verdictWord(v.verdict)} />
            </View>
            {/* Whether anybody picked up is the first thing worth knowing: a
                verdict off a call that never connected is a verdict about
                nothing. Who made it is beside it — the way to argue with an
                answer is to ring whoever wrote it down. */}
            <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 4 }, weight(400)]}>
              {[v.reached ? 'Spoke to them' : 'Could not reach them', pretty(isoDate(new Date(v.calledAt))), v.calledByName]
                .filter(Boolean)
                .join(' · ')}
              {v.syncState === 'queued' ? ' · not sent yet' : ''}
            </Text>
            {told(v, lead).map((t) => (
              <Text key={t.label} style={[{ fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 6 }, weight(400)]}>
                {t.label + ': ' + t.said}
                {/* Only where the two readings differ. */}
                {t.differsFrom ? <Text style={[{ fontSize: 12, color: C.warnInk }, weight(400)]}>{' · you have ' + t.differsFrom}</Text> : null}
              </Text>
            ))}
            {v.salesmanFeedback?.trim() ? (
              <Text style={[{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 6 }, weight(400)]}>
                {'About the visit: ' + v.salesmanFeedback.trim()}
              </Text>
            ) : null}
            {/* §8's OTHER ANSWERS, in §8's own words. An unanswered question
                is LEFT OUT rather than drawn blank: null is nobody having
                asked, and a blank line asserts the shop said no. */}
            {alsoSaid(v).map((a) => (
              <View key={a.id} style={{ marginTop: 6 }}>
                <Text style={[{ fontSize: 12, lineHeight: 16, color: C.faint }, weight(400)]}>{a.ask}</Text>
                <Text style={[{ marginTop: 2, fontSize: 14, lineHeight: 20, color: C.ink }, weight(400)]}>{a.said}</Text>
              </View>
            ))}
            {v.verdictReason ? (
              <Text style={[{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 4 }, weight(400)]}>{v.verdictReason}</Text>
            ) : null}
          </LeadCard>
        );
      })}

      {/* ------------------------------------------------- §25 the timeline */}
      <LeadCard style={{ borderRadius: 22 }}>
        <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>History</Text>
        {events.length === 0 ? (
          <Text style={[{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 10 }, weight(400)]}>
            Nothing here yet. Add a note. Write what they buy now, and from whom.
          </Text>
        ) : (
          events.map((e) => (
            <View key={e.id} style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: e.kind === 'note' ? C.faint : C.primary }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(e.kind === 'note' ? 400 : 600)]}>{e.summary}</Text>
                {e.detail ? (
                  <Text style={[{ fontSize: 13, lineHeight: 18, color: C.muted }, weight(400)]}>{e.detail}</Text>
                ) : null}
                <Text style={[{ fontSize: 12, lineHeight: 16, color: C.muted }, weight(400)]}>
                  {[pretty(isoDate(new Date(e.occurredAt))), e.actor].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </View>
          ))
        )}

        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <VoiceField
              value={note}
              onChangeText={setNote}
              placeholder="Buys 20 cans a month from Asian, wants 45 days credit"
              style={{ minHeight: 52, borderRadius: 18, backgroundColor: C.canvas, borderWidth: 0 }}
            />
          </View>
          <Pressable
            onPress={saveNote}
            accessibilityRole="button"
            accessibilityLabel="Add note"
            style={({ pressed }) => ({ width: 52, height: 52, borderRadius: 26, backgroundColor: pressed ? C.primaryDeep : C.primary, alignItems: 'center', justifyContent: 'center' })}>
            <Icon name="add" size={22} color="#FFFFFF" strokeWidth={2.2} />
          </Pressable>
        </View>
      </LeadCard>

      {/* --------------------------------------------------------- ending */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {settled ? null : (
          <>
            {/* ON HOLD SITS BESIDE LOST, AND THAT PLACEMENT IS THE POINT.
                This is the moment a salesman is standing in front of the two
                answers — the plant is shut for two months, or they are never
                buying — and a park drawn anywhere else is a park nobody finds
                at the moment they are reaching for Lost. A parked lead has the
                card above with "Bring it back" on it instead. */}
            {parked ? null : (
              <EndTile glyph="pause" ink={C.warnInk} label="Put on hold" a11y="Put it on hold" onPress={() => setHold({ step: 'why' })} />
            )}
            <EndTile icon="close" ink={C.danger} label="Mark lost" onPress={() => setLost(true)} />
          </>
        )}
        <EndTile
          icon={lead.archived ? 'reorder' : 'lock'}
          ink={C.muted}
          label={lead.archived ? 'Bring back' : 'Close (hide)'}
          a11y={lead.archived ? 'Bring it back to the list' : 'Close it (hide from list)'}
          onPress={() => {
            void setArchived(lead.id, !lead.archived, today).then(() => {
              load();
              notify(lead.archived ? 'Back on the list' : 'Closed. Find it under Archived.');
            });
          }}
        />
      </View>

      {/* ---------------------------------------------------------- sheets */}

      {/* §26 — ten reasons, and a sentence beside whichever one it was. */}
      <ReasonSheet
        key={lost ? 'lost-open' : 'lost-shut'}
        open={lost}
        onClose={() => setLost(false)}
        title="Mark this lead lost?"
        body={title + ' moves to Lost, with the reason. Nobody will call this shop again.'}
        options={config.lostReasons}
        confirmLabel="Mark it lost"
        noteLabel="What they actually said"
        onConfirm={(code, said) => {
          setLost(false);
          void markLost(lead.id, code, said).then((r) => {
            if (!r.ok) return notify(r.message, 'warn');
            load();
            notify('Lost');
          });
        }}
      />

      {suspectSheet()}

      {/* ------------------------------------------------- §— the park, in three

          Each sheet hands its answers to the next one in `hold`, and the write
          happens once, at the end of the third — so a salesman who backs out
          half way has parked nothing, which is right: two of three answers is
          the park this whole flow exists to refuse. Every one of them is keyed
          on the step it belongs to, so it remounts with fresh state rather
          than being reset in an effect, which the React Compiler rules forbid
          and which is how a second park would arrive carrying the first's
          answers. */}
      <ReasonSheet
        key={hold?.step === 'why' ? 'hold-why-open' : 'hold-why-shut'}
        open={hold?.step === 'why'}
        onClose={() => setHold(null)}
        title="Put this lead on hold?"
        body={
          title +
          ' will not be followed up until the day you choose. It is not lost. It stays on your list.'
        }
        options={config.holdReasons}
        confirmLabel="Next: choose return day"
        noteLabel="What they actually said"
        /* Only "Other" costs a sentence. A code meaning "something else" with
           nothing behind it is the one row nobody can act on afterwards, and
           it is the code people reach for when the list does not fit. */
        noteRequiredForCode={REASON_CODE_NEEDING_REMARKS}
        onConfirm={(code, said) => setHold({ step: 'until', code, note: said })}
      />

      <BottomSheet open={hold?.step === 'until'} onClose={() => setHold(null)} scroll>
        <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
          When does it come back?
        </Text>
        <T s="caption" style={{ marginTop: 2 }}>
          {/* The sentence says what the date DOES, because a date on a screen
              that does nothing is how "back after Diwali" became a lead nobody
              looked at for six months. */}
          Back on your list that day, with the next action you set · step 2 of 3
        </T>
        <View style={{ marginTop: 14 }}>
          <Calendar
            key={hold?.step === 'until' ? 'hold-cal-open' : 'hold-cal-shut'}
            selected=""
            /* Today is refused rather than merely past days: a hold that ends
               on the day it is made is not a hold, and the screen saying so is
               kinder than a park that quietly means nothing. */
            disabledReason={(iso) =>
              iso <= today ? 'Choose a day after today.' : null
            }
            onPick={(iso) =>
              setHold((h) => (h?.step === 'until' ? { step: 'next', code: h.code, note: h.note, until: iso } : h))
            }
          />
        </View>
        <PillButton label="Cancel" variant="outline" height={48} onPress={() => setHold(null)} style={{ marginTop: 10 }} />
      </BottomSheet>

      <NextActionSheet
        key={hold?.step === 'next' ? 'hold-next-open' : 'hold-next-shut'}
        open={hold?.step === 'next'}
        onClose={() => setHold(null)}
        meId={me?.id ?? ''}
        meName={me?.name ?? 'You'}
        managerId={lead.leadManagerId}
        managerName={lead.leadManagerName}
        /* Pre-filled with the day the park ends, because that is the ordinary
           answer — the action is what happens WHEN it comes back. He can move
           it, and the lead still returns to his list on the resume date rather
           than on whatever he moved it to: `putOnHold` says why. */
        current={{
          action: lead.nextAction,
          date: hold?.step === 'next' ? hold.until : null,
          ownerId: lead.nextActionOwnerId,
        }}
        onSave={(n) => {
          if (hold?.step !== 'next') return;
          if (parking.current) return;
          parking.current = true;
          const until = hold.until;
          setHold(null);
          void putOnHold(lead.id, {
            reasonCode: hold.code,
            note: hold.note,
            resumeDate: until,
            next: n,
          })
            .then((r) => {
              if (!r.ok) return notify(r.message, 'warn');
              load();
              notify('On hold until ' + dmy(until));
            })
            .finally(() => {
              parking.current = false;
            });
        }}
      />

      <NextActionSheet
        key={nextOpen ? 'next-open' : 'next-shut'}
        open={nextOpen}
        onClose={() => setNextOpen(false)}
        meId={me?.id ?? ''}
        meName={me?.name ?? 'You'}
        /* The lead manager can be named as the owner here too, as the hold
           flow already allowed — "the manager rings them on Friday" is an
           ordinary next action, not only a parked one. */
        managerId={lead.leadManagerId}
        managerName={lead.leadManagerName}
        current={{ action: lead.nextAction, date: lead.nextActionDate, ownerId: lead.nextActionOwnerId }}
        onSave={(n) => {
          setNextOpen(false);
          void setNextAction(lead.id, n).then((r) => {
            if (!r.ok) return notify(r.message, 'warn');
            load();
            notify('Next: ' + n.action);
          });
        }}
      />

      <LadderSheet
        key={ladderOpen ? 'ladder-open' : 'ladder-shut'}
        open={ladderOpen}
        current={salesType}
        onClose={() => setLadderOpen(false)}
        onPick={(t, reason) => {
          setLadderOpen(false);
          void setSalesType(lead.id, t, reason).then((r) => {
            if (!r.ok) return notify(r.message, 'warn');
            load();
            notify(salesTypeLabel(t) + '. Lead goes back to the first stage.');
          });
        }}
      />

      {/* §5.5 §9 — what they said they would order. Keyed like every other
          sheet here so it remounts with the record's own answers rather than
          being reset in an effect. */}
      <CommitmentSheet
        key={commitOpen ? 'commit-open' : 'commit-shut'}
        open={commitOpen}
        today={today}
        productName={lead.requiredProductName}
        productId={lead.requiredProductId}
        blockers={config.orderBlockers}
        current={{
          date: lead.expectedOrderDate,
          quantityCans: lead.expectedOrderQuantityCans,
          valuePaise: lead.expectedOrderValuePaise,
          blockerCode: lead.expectedOrderBlockerCode,
        }}
        onClose={() => setCommitOpen(false)}
        onSave={(c) => {
          if (committing.current) return;
          committing.current = true;
          setCommitOpen(false);
          void recordExpectedOrder(lead.id, {
            expectedDate: c.date,
            expectedQuantityCans: c.quantityCans,
            expectedValuePaise: c.valuePaise,
            blockerCode: c.blockerCode,
          })
            .then((r) => {
              if (!r.ok) return notify(r.message, 'warn');
              load();
              /* The confirmation says what it DID and, in the same breath, what
                 it did not: a salesman who has just written down a promise will
                 reasonably look for the ladder to have moved. */
              notify(plural(c.quantityCans, 'can') + ' expected ' + dmy(c.date) + '. Saved. This is not an order.');
            })
            .finally(() => {
              committing.current = false;
            });
        }}
      />

      <PartiesSheet
        key={parties ? 'parties-open' : 'parties-shut'}
        open={parties}
        lead={lead}
        onClose={() => setParties(false)}
        onSave={(p) => {
          setParties(false);
          void setLeadParties(lead.id, p).then((r) => {
            if (!r.ok) return notify(r.message, 'warn');
            load();
            notify('Saved');
          });
        }}
      />
    </AppFrame>
  );

  /* The suspect decision is rendered from two places — the forced screen and
     the ordinary record — so it is built once here rather than copied. */
  function suspectSheet() {
    if (!view) return null;
    const asking = suspect;
    return (
      <ReasonSheet
        key={asking ? 'suspect-' + asking : 'suspect-shut'}
        open={asking !== null}
        onClose={() => setSuspect(null)}
        title={asking === 'not' ? 'Not a prospect?' : 'Make this a Prospect?'}
        body={
          asking === 'not'
            ? 'It closes with the reason. It stays on the list under Lost.'
            : 'Your sales manager will now work on it too. They will call the customer to check.'
        }
        options={asking === 'not' ? view.config.lostReasons : view.config.prospectReasons}
        confirmLabel={asking === 'not' ? 'Close it' : 'Make it a Prospect'}
        noteLabel="What they said"
        onConfirm={(code, said) => {
          const wanted = asking === 'prospect';
          setSuspect(null);
          void decideSuspect(view.lead.id, { prospect: wanted, reasonCode: code, note: said }).then((r) => {
            if (!r.ok) {
              notify(r.message, 'warn');
              /* A shut gate is answered on Prospect details, not here. */
              if (r.missing?.length) router.push(`/lead-prospect?id=${view.lead.id}&from=lead`);
              return;
            }
            load();
            notify(wanted ? 'Now a Prospect' : 'Closed');
          });
        }}
      />
    );
  }
}

/** A label and a value on one line — the record's own small table. */
function LadderSheet({
  open,
  current,
  onClose,
  onPick,
}: {
  open: boolean;
  current: LeadSalesType | null;
  onClose: () => void;
  onPick: (t: LeadSalesType, reason: string) => void;
}) {
  const [picked, setPicked] = React.useState<LeadSalesType | null>(current);
  const [reason, setReason] = React.useState('');

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
        Kind of sale
      </Text>
      <Text
        accessibilityLabel="This decides which questions come next. If you change it, the lead goes back to the first stage."
        style={[{ fontSize: 12, lineHeight: 17, color: C.danger, marginTop: 2 }, weight(600)]}>
        Changing it sends the lead back to the first stage
      </Text>

      {/* The same withdrawal as the raise screen, and it bites hardest here:
          this sheet is the one place a lead could be MOVED onto the
          distributor ladder. The server refuses it too, because an APK cannot
          be recalled and an older build goes on drawing the chip. A lead
          already on that ladder is untouched — it sits at `current`, the
          button below is disabled while `picked === current`, and nothing here
          takes it off. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {offeredSalesTypes().map((t) => (
          <PickTile key={t.code} label={t.label} sub={t.hint} on={picked === t.code} onPress={() => setPicked(t.code)} />
        ))}
      </View>

      <WashInput
        value={reason}
        onChangeText={setReason}
        placeholder="Why it is changing (optional)"
        style={{ marginTop: 8 }}
      />

      <PrimaryButton
        label="Change it"
        disabled={!picked || picked === current}
        whyDisabled={!picked ? 'Choose one first.' : 'It is already this.'}
        onPress={() => picked && picked !== current && onPick(picked, reason)}
        style={{ marginTop: 12, borderRadius: 28 }}
      />
      <PillButton label="Cancel" variant="outline" height={48} onPress={onClose} style={{ marginTop: 8 }} />
    </BottomSheet>
  );
}

function PartiesSheet({
  open,
  lead,
  onClose,
  onSave,
}: {
  open: boolean;
  lead: Lead;
  onClose: () => void;
  onSave: (p: {
    thirdParty: boolean;
    distributorCustomerId?: string | null;
    distributorName?: string | null;
    distributorSalesmanName?: string | null;
  }) => void;
}) {
  const [thirdParty, setThirdParty] = React.useState(Boolean(lead.thirdParty));
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<{ id: string; name: string; city: string | null }[]>([]);
  const [chosen, setChosen] = React.useState<{ id: string; name: string } | null>(
    lead.distributorCustomerId ? { id: lead.distributorCustomerId, name: lead.distributorName ?? 'Distributor' } : null,
  );
  const [salesman, setSalesman] = React.useState(lead.distributorSalesmanName ?? '');

  React.useEffect(() => {
    let live = true;
    void distributorCandidates(query).then((r) => {
      if (live) setHits(r);
    });
    return () => {
      live = false;
    };
  }, [query]);

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(800)]}>
        Who bills this shop?
      </Text>
      <Text
        accessibilityLabel="If we deliver but do not bill the shop, it is a third-party customer. Say who bills it."
        style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 2 }, weight(400)]}>
        We deliver, a distributor bills → third-party
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <SheetChip label="We bill" a11y="We do" on={!thirdParty} onPress={() => setThirdParty(false)} />
        <SheetChip label="A distributor bills" a11y="A distributor" on={thirdParty} onPress={() => setThirdParty(true)} />
      </View>

      {thirdParty ? (
        <>
          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            <SearchBox value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search your accounts" bg={C.canvas} />
          </View>
          <View style={{ gap: 8, marginTop: 8 }}>
            {hits.map((h) => (
              <PickTile
                key={h.id}
                label={h.name}
                sub={h.city ?? undefined}
                on={chosen?.id === h.id}
                onPress={() => setChosen({ id: h.id, name: h.name })}
                wide
              />
            ))}
            {hits.length === 0 ? (
              <Text style={[{ fontSize: 12, lineHeight: 16, color: C.faint }, weight(400)]}>No match. You can only choose shops we bill.</Text>
            ) : null}
          </View>

          <WashInput
            icon="person"
            value={salesman}
            onChangeText={setSalesman}
            placeholder="Their salesman for this shop, e.g. Rahul"
            style={{ marginTop: 10 }}
          />
          <Text style={[{ fontSize: 11, lineHeight: 15, color: C.faint, marginTop: 4 }, weight(400)]}>
            Their salesman · a name is enough. He has no login here and does not need one.
          </Text>
        </>
      ) : null}

      <PrimaryButton
        label="Save"
        tone="navy"
        disabled={thirdParty && !chosen}
        whyDisabled="Choose the distributor who bills this shop."
        onPress={() => {
          if (thirdParty && !chosen) return;
          onSave({
            thirdParty,
            distributorCustomerId: thirdParty ? chosen?.id ?? null : null,
            distributorName: thirdParty ? chosen?.name ?? null : null,
            distributorSalesmanName: thirdParty ? salesman.trim() || null : null,
          });
        }}
        style={{ marginTop: 12, borderRadius: 28 }}
      />
      <PillButton label="Cancel" variant="outline" height={48} onPress={onClose} style={{ marginTop: 8 }} />
    </BottomSheet>
  );
}

function told(
  v: Awaited<ReturnType<typeof validationsFor>>[number],
  lead: Lead,
): { label: string; said: string; differsFrom: string | null }[] {
  const rows: { label: string; said: string; differsFrom: string | null }[] = [];

  const differs = (a: string | null | undefined, b: string | null | undefined) => {
    const mine = (b ?? '').trim();
    /* Nothing to disagree WITH is not a disagreement. A lead the salesman
       never answered for is one the office has just filled in, and calling
       that a contradiction would put an accusation on an empty field. */
    if (!mine) return null;
    return mine.toLowerCase() === (a ?? '').trim().toLowerCase() ? null : mine;
  };

  if (v.confirmedRequirement?.trim()) {
    rows.push({
      label: 'What they want',
      said: v.confirmedRequirement.trim(),
      differsFrom: differs(v.confirmedRequirement, lead.requirement),
    });
  }
  if (v.confirmedMonthlyVolumeLitres != null) {
    const mine = lead.monthlyLitres ?? lead.monthlyVolumeLitres;
    rows.push({
      label: 'Uses',
      said: plural(v.confirmedMonthlyVolumeLitres, 'litre') + ' a month',
      differsFrom:
        mine != null && mine !== v.confirmedMonthlyVolumeLitres ? plural(mine, 'litre') + ' a month' : null,
    });
  }
  if (v.confirmedCompetitor?.trim()) {
    rows.push({
      label: 'Buys from now',
      said: v.confirmedCompetitor.trim(),
      differsFrom: differs(v.confirmedCompetitor, lead.competitor ?? lead.competitorName),
    });
  }
  if (v.confirmedPotentialPaise != null) {
    const mine = lead.estimatedPotentialPaise;
    rows.push({
      label: 'Can buy',
      said: inrFromPaise(v.confirmedPotentialPaise) + ' a month',
      differsFrom: mine != null && mine !== v.confirmedPotentialPaise ? inrFromPaise(mine) + ' a month' : null,
    });
  }

  return rows;
}

/**
 * WHAT ELSE THE OFFICE ASKED, AND WHAT THEY SAID TO IT.
 *
 * `told` above is the four CONFIRMED figures, which are drawn as a comparison
 * because their whole value is that they can disagree with what the salesman
 * wrote down. These are the rest of §8's seventeen, which are answers and not
 * figures: nothing on this lead contradicts them, so they are drawn as the
 * question and the sentence under it, in the wording the caller read out.
 *
 * The question comes from `VERIFICATION_QUESTIONS` and the column it lands in
 * from `VERIFICATION_COLUMNS` — the same two lists the form on this phone draws
 * from and the office's own form writes through. A label typed in here would be
 * the copy that drifts, and the half that drifts is the half somebody reads.
 *
 * The three drawn ABOVE are left out rather than repeated: `confirmedRequirement`
 * and `confirmedCompetitor` are two of `told`'s four, and `salesmanFeedback` is
 * the "About the visit" line. One answer printed twice on one card reads as the
 * shop having said it twice.
 */
const DRAWN_ABOVE = new Set(['confirmedRequirement', 'confirmedCompetitor', 'salesmanFeedback']);

function alsoSaid(
  v: Awaited<ReturnType<typeof validationsFor>>[number],
): { id: string; ask: string; said: string }[] {
  const row = v as unknown as Record<string, unknown>;
  return VERIFICATION_QUESTIONS.flatMap((q) => {
    const column = VERIFICATION_COLUMNS[q.id];
    if (!column || DRAWN_ABOVE.has(column)) return [];
    const said = row[column];
    /* A blank is nobody having asked, which is a different fact from the shop
       having nothing to say — and only the second is worth a line. */
    if (typeof said !== 'string' || !said.trim()) return [];
    return [{ id: q.id, ask: q.ask, said: said.trim() }];
  });
}

/**
 * The stored verdict, in words somebody would say.
 *
 * `not_qualified` on a badge is the database talking. Anything unrecognised
 * falls through to "Waiting" rather than being printed raw — a verdict added
 * at a desk should read as pending on an older handset, not as an enum.
 */
function verdictWord(v: string): string {
  switch (v) {
    case 'confirmed': return 'Confirmed';
    case 'not_qualified': return 'Not qualified';
    case 'on_hold': return 'On hold';
    default: return 'Waiting';
  }
}

/* ------------------------------------------------------ V3 record pieces */

/** A 28 tag in the lavender hero — the stage, the priority, the kind of sale. */
function HeroTag({ tone, text, a11y, flag }: { tone: BadgeTone | 'white'; text: string; a11y?: string; flag?: boolean }) {
  const t = tone === 'white' ? { bg: C.surface, fg: HERO.lavender.ink } : STAGE_PILL[tone];
  return (
    <View
      accessible
      accessibilityLabel={a11y ?? text}
      style={{ minHeight: 28, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 14, backgroundColor: t.bg, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {flag ? <LeadGlyph name="flag" size={12} color={t.fg} strokeWidth={2.4} /> : null}
      <Text style={[{ fontSize: 12, lineHeight: 17, color: t.fg }, weight(700)]}>{text}</Text>
    </View>
  );
}

/** One fact under the name in the hero: the contact, the town, the number. */
function HeroFact({ icon, text }: { icon?: IconName; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {icon ? <Icon name={icon} size={13} color={HERO.lavender.muted} strokeWidth={2.2} /> : null}
      <Text numberOfLines={1} style={[{ fontSize: 13, lineHeight: 18, color: HERO.lavender.muted }, weight(400)]}>
        {text}
      </Text>
    </View>
  );
}

/** A quiet white chip — where it came from, the customer it became. */
function InfoChip({ text, icon, onPress }: { text: string; icon?: IconName; onPress?: () => void }) {
  const body = (
    <View
      style={{
        minHeight: 32,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        backgroundColor: onPress ? C.primaryTint : C.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
      }}>
      {icon ? <Icon name={icon} size={14} color={onPress ? C.primaryDeep : C.muted} strokeWidth={2.2} /> : null}
      <Text style={[{ fontSize: 12, lineHeight: 16, color: onPress ? C.primaryDeep : C.muted }, weight(onPress ? 700 : 600)]}>{text}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={text} hitSlop={8}>
      {body}
    </Pressable>
  );
}

/** One of the three figures under the hero. */
function StatTile({ icon, value, sub, a11y }: { icon: IconName; value: string; sub: string; a11y: string }) {
  return (
    <View accessible accessibilityLabel={a11y} style={{ flex: 1, minWidth: 0, backgroundColor: C.surface, borderRadius: 18, padding: 12 }}>
      <Icon name={icon} size={18} color={C.primaryDeep} strokeWidth={2} />
      <Text numberOfLines={1} style={[{ fontSize: 19, lineHeight: 24, color: C.ink, marginTop: 8 }, weight(800)]}>{value}</Text>
      <Text numberOfLines={1} style={[{ fontSize: 12, lineHeight: 16, color: C.muted }, weight(400)]}>{sub}</Text>
    </View>
  );
}

/** The glyph beside a "found in the shop" line. */
function LearnedIcon({ label, finding }: { label: string; finding?: string }) {
  const name: IconName =
    label === 'Where it is' ? 'pin' : finding === 'required_product' ? 'sample' : finding === 'competitor' ? 'shop' : 'note';
  if (finding === 'monthly_litres') return <LeadGlyph name="drop" size={18} color={C.muted} strokeWidth={2} />;
  return <Icon name={name} size={18} color={C.muted} strokeWidth={2} />;
}

/** A rung on the stage card: navy where he stands, a lock on the shut one above. */
function RungChip({ label, on, locked, onPress }: { label: string; on: boolean; locked: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label + (on ? ', you are here' : locked ? ', locked' : '')}
      hitSlop={{ top: 8, bottom: 8 }}
      style={{
        minHeight: 32,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 16,
        backgroundColor: on ? C.navy : C.canvas,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}>
      {locked ? <Icon name="lock" size={12} color={C.muted} strokeWidth={2.2} /> : null}
      <Text style={[{ fontSize: 12, lineHeight: 17, color: on ? '#FFFFFF' : C.ink }, weight(600)]}>{label}</Text>
    </Pressable>
  );
}

/** A square of the "work to do" grid — the forms, the sample, who bills it. */
function WorkTile({
  icon,
  label,
  sub,
  subTone,
  locked = false,
  a11y,
  onPress,
}: {
  icon: IconName;
  label: string;
  sub?: string;
  subTone?: 'warn';
  locked?: boolean;
  a11y: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: locked }}
      accessibilityLabel={a11y}
      style={({ pressed }) => ({
        flexGrow: 1,
        flexBasis: '45%',
        minHeight: 84,
        borderRadius: 20,
        backgroundColor: pressed ? C.wash : C.surface,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 10,
      })}>
      <Icon name={locked ? 'lock' : icon} size={20} color={locked ? C.faint : C.primaryDeep} strokeWidth={2} />
      <Text numberOfLines={2} style={[{ fontSize: 13, lineHeight: 17, color: locked ? C.faint : C.ink, textAlign: 'center' }, weight(700)]}>
        {label}
      </Text>
      {sub ? (
        <Text numberOfLines={1} style={[{ fontSize: 11, lineHeight: 15, color: subTone === 'warn' ? C.warnInk : C.muted, textAlign: 'center' }, weight(600)]}>
          {sub}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One of the three ending tiles: hold, lost, close. */
function EndTile({
  icon,
  glyph,
  ink,
  label,
  a11y,
  onPress,
}: {
  icon?: IconName;
  glyph?: 'pause';
  ink: string;
  label: string;
  a11y?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 72,
        borderRadius: 20,
        backgroundColor: pressed ? C.wash : C.surface,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      })}>
      {glyph ? <LeadGlyph name={glyph} size={20} color={ink} /> : icon ? <Icon name={icon} size={20} color={ink} strokeWidth={2} /> : null}
      <Text style={[{ fontSize: 12, lineHeight: 17, color: ink }, weight(700)]}>{label}</Text>
    </Pressable>
  );
}

/** A choice tile in a sheet: the brand edge when picked. */
function PickTile({ label, sub, on, onPress, wide = false }: { label: string; sub?: string; on: boolean; onPress: () => void; wide?: boolean }) {
  return (
    <Pressable
      onPress={() => {
        if (!on) feedback('select');
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={sub ? label + '. ' + sub : label}
      style={({ pressed }) => ({
        flexGrow: 1,
        flexBasis: wide ? '100%' : '45%',
        minHeight: 52,
        borderRadius: 18,
        borderWidth: on ? 2 : 1,
        borderColor: on ? C.primary : C.border,
        backgroundColor: on ? C.primaryTint : pressed ? C.wash : C.surface,
        paddingHorizontal: on ? 13 : 14,
        paddingVertical: on ? 7 : 8,
        justifyContent: 'center',
      })}>
      <Text style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>{label}</Text>
      {sub ? <Text style={[{ fontSize: 11, lineHeight: 15, color: C.muted }, weight(400)]}>{sub}</Text> : null}
    </Pressable>
  );
}


