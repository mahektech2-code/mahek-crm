import React from 'react';
import { Image, View, Pressable, ScrollView } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { Icon } from '../src/components/ui/Icon';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { CommitmentCard } from '../src/components/leads/commitment-card';
import { CommitmentSheet } from '../src/components/leads/commitment-sheet';
import { NextActionSheet } from '../src/components/leads/next-action-sheet';
import { RelationshipChain } from '../src/components/leads/relationship-chain';
import { ReasonSheet } from '../src/components/leads/reason-sheet';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import {
  convertToCustomer,
  leadThresholds,
  setArchived,
  setFollowUp,
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
import { leadAlert, type LeadThresholds } from '../src/engines/leads';
import {
  findingLabel,
  gateTo,
  isParked,
  isTerminal,
  labelOf,
  ladderFor,
  offeredSalesTypes,
  REASON_CODE_NEEDING_REMARKS,
  salesTypeLabel,
  stageLabel,
  stageSentence,
  VERIFICATION_COLUMNS,
  VERIFICATION_QUESTIONS,
  type LeadSalesType,
  type LeadStage,
} from '../src/engines/funnel';
import { dmy, inrFromPaise, isoDate, plural, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';

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

const STAGE_TONE: Record<string, BadgeTone> = {
  New: 'info',
  Contacted: 'teal',
  Qualified: 'amber',
  Negotiation: 'amber',
  Converted: 'success',
  Lost: 'danger',
};

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
  const askConfirm = useStore((s) => s.askConfirm);
  const set = useStore((s) => s.set);

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
  const [cal, setCal] = React.useState(false);
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
    });
    return () => {
      live = false;
    };
  }, [id]);

  useFocusEffect(load);

  if (!view) {
    return (
      <AppFrame title="Lead" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
        <BackLink label={back.label} onPress={back.go} />
        <Card style={{ paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>This lead is not on this phone</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            Go back to the list and open it from there.
          </T>
        </Card>
      </AppFrame>
    );
  }

  const { lead, salesType, stage, next, gate, mustDecide, visits, config, input } = view;
  const settled = stage === 'lost' || stage === 'won';
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
    learned.push({ label: 'Gets through', value: plural(litres, 'litre') + ' a month', finding: 'monthly_litres' });
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

  /* --------------------------------------------------------- §4 the window
   *
   * Past the cap this is the entire screen. Not a banner over the record and
   * not a disabled button: the specification forces the decision, and a
   * salesman who can still add a note and set a follow-up will do exactly that
   * for another three weeks.
   */
  if (mustDecide) {
    return (
      <AppFrame title="Lead" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
        <BackLink label={back.label} onPress={back.go} />

        <Card>
          <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]}>{title}</T>
          <T s="caption" style={{ marginTop: 2 }}>
            {[lead.city, lead.mobile].filter(Boolean).join(' · ')}
          </T>

          <Divider style={{ marginVertical: 14 }} />

          <T style={[{ fontSize: 17, lineHeight: 24, color: C.ink }, weight(600)]}>
            {'You have been ' + plural(visits, 'time') + '. Is this worth pursuing?'}
          </T>
          <T style={{ fontSize: 15, lineHeight: 22, color: C.muted, marginTop: 6 }}>
            {'A suspect gets ' + config.suspectMaxVisits +
              ' visits to become something, and this one has had them. Nothing else on this record works until you answer — that is the point of the question, not a fault.'}
          </T>

          <PrimaryButton
            label="Yes — make it a Prospect"
            onPress={() => setSuspect('prospect')}
            style={{ marginTop: 16 }}
          />
          <SecondaryButton
            label="No — not a prospect"
            onPress={() => setSuspect('not')}
            style={{ marginTop: 10 }}
          />
        </Card>

        {suspectSheet()}
      </AppFrame>
    );
  }

  /* ------------------------------------------------------------- the moves */

  const move = async (to: LeadStage) => {
    const r = await advanceStage(lead.id, to);
    if (!r.ok) return notify(r.message);
    load();
    notify(stageLabel(to));
  };

  const saveNote = async () => {
    const r = await addLeadNote(lead.id, note);
    if (!r.ok) return notify(r.message);
    setNote('');
    load();
    notify('Noted');
  };

  const convert = () =>
    askConfirm({
      title: 'Make them a customer?',
      body: title + ' becomes an account you can order against. The lead stays, linked to it, and this cannot be undone.',
      confirmLabel: 'Convert',
      run: () => {
        void convertToCustomer(lead, today).then((r) => {
          if (!r.ok) return notify(r.message);
          notify('Customer created · ' + title);
          set({ custId: r.value, pTab: 0 });
          router.push('/customer');
        });
      },
    });

  /* §9 §10 — the sample is gated on the twelve, same as everything else. */
  const sampleGate = gateTo(input, 'sample_trial');
  const alert = cfg ? leadAlert(lead, today, cfg) : null;
  const ladder = ladderFor(salesType);

  return (
    <AppFrame title="Lead" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* ---------------------------------------------------------- who */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]}>{title}</T>
            <T s="caption" style={{ marginTop: 2 }}>
              {[lead.company?.trim() ? lead.name : null, lead.city, lead.source].filter(Boolean).join(' · ')}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <Badge tone={STAGE_TONE[lead.stage] ?? 'neutral'}>{stageLabel(stage)}</Badge>
            {/* §4.1 — HOW HARD TO PUSH, and it is READ-ONLY on this phone.
                It is the manager's judgement about the WORK — which of forty
                leads to get to first — as against the potential below, which is
                a judgement about the account. A priority the person being
                measured could set himself would follow whatever he felt like
                doing, which is why `lead.verify` gates it and why there is no
                control here. It has ridden down on every pull since the wire
                change and was drawn by nothing, so a manager marking forty
                leads high was talking to himself.

                Null is nobody having judged it and is NOT the same as low, so
                nothing is drawn at all — a "Low" badge on an unjudged lead is a
                verdict the screen invented. */}
            {lead.priority ? (
              <Badge tone={PRIORITY_TONE[lead.priority] ?? 'neutral'}>
                {priorityWord(lead.priority)}
              </Badge>
            ) : null}
          </View>
        </View>

        <T style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 8 }}>{stageSentence(stage)}</T>

        <Divider style={{ marginVertical: 12 }} />

        <View style={{ gap: 8 }}>
          <Line label="Kind of sale" value={salesTypeLabel(salesType)} />
          {/* THE NUMBER IS NOW DIALLABLE, and it was text.
              A lead is a shop nobody has sold to yet, so ringing them is most
              of the work — and this screen printed the number as a label with
              no way to call it, while the customer record two taps away has
              had a call button since it was written.

              Ringing is also the one thing `touchLead` was written for and
              never got: staleness, the archive prompt and the untouched-lead
              escalation all measure from `lastActivityDate`, the stage and
              note paths bump it themselves, and its docstring names "a call
              placed" as the case nothing covered. So a lead worked hardest by
              phone was the one the app decided had been abandoned. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Line label="Mobile" value={lead.mobile ?? 'Not taken'} />
            </View>
            {lead.mobile ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'Ring ' + title}
                onPress={() => {
                  void callNumber(lead.mobile!).then((out) => {
                    if (out.status === 'failed') return notify(out.reason);
                    /* The clock moves on the ATTEMPT, not on a connected call:
                       the handset cannot tell us whether they picked up, and
                       treating an unanswered ring as no work would age exactly
                       the leads somebody is chasing hardest. */
                    void touchLead(lead.id, today).then(load);
                  });
                }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 48,
                  paddingHorizontal: 14,
                  borderRadius: radius.sm,
                  borderWidth: 1,
                  borderColor: C.primary,
                  backgroundColor: pressed ? C.wash : C.primaryTint,
                })}>
                <Icon name="call" size={16} color={C.primaryDeep} />
                <T style={[{ fontSize: 14, color: C.primaryDeep }, weight(500)]}>Ring</T>
              </Pressable>
            ) : null}
          </View>
          <Line
            label="Might buy"
            value={lead.estimatedPotentialPaise ? inrFromPaise(lead.estimatedPotentialPaise) + ' a month' : 'Not estimated'}
          />
          {/* Where it actually came from, in more words than "manual". The
              subtitle above carries the SOURCE, which on a real book is one of
              eight codes; this is the sentence behind it — which exhibition,
              whose referral — and it is the half somebody opens the record for.
              Drawn only where there is one: an empty row labelled "Came from"
              is an invitation to fill a box this screen cannot open. */}
          {lead.sourceDetail?.trim() ? (
            <Line label="Came from" value={lead.sourceDetail.trim()} />
          ) : null}
          <Line label="Visits" value={plural(visits, 'visit')} />
          <Line label="Next follow-up" value={lead.nextFollowUpDate ? pretty(lead.nextFollowUpDate) : 'None set'} />
        </View>

        {alert ? (
          <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.warnInk }, weight(500)]}>{alert}</T>
        ) : null}

        {stage === 'lost' && lead.lostReason ? (
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.danger }}>{'Lost — ' + lead.lostReason}</T>
        ) : null}

        {/* Why it is not moving. It was on the list card and nowhere on the
            record, which is the screen somebody opens to find out. One column
            answers two questions — "what is this on hold for" and "why is this
            still a Suspect" — so it is drawn for both; a parked lead gets it
            from the card below instead, so the sentence is on the screen once. */}
        {lead.holdReason && !parked ? (
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.warnInk }}>
            {'Waiting: ' + lead.holdReason}
          </T>
        ) : null}

        {/* §4 — visits one and two just say where he is up to. The count is
            the useful half; the demand only arrives at the cap. */}
        {stage === 'suspect' && !lead.suspectDecidedAt ? (
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.muted }}>
            {'Visit ' + Math.max(1, visits) + ' of ' + config.suspectMaxVisits +
              ' — decide by then whether this is a prospect.'}
          </T>
        ) : null}

        {lead.convertedCustomerId ? (
          <SecondaryButton
            label="Open the customer"
            onPress={() => {
              set({ custId: lead.convertedCustomerId ?? '', pTab: 0 });
              router.push('/customer');
            }}
            style={{ marginTop: 12 }}
          />
        ) : null}
      </Card>

      {/* ------------------------------- §A what he learned in the shop --

          Written on the capture sheet outside the shop and shown nowhere
          afterwards — the address, what they want, what they get through, who
          they buy from now and the photograph of the shop front. Seven
          optional fields went in and none of them came out, so the next visit
          started from nothing and he stopped filling them in. */}
      {learned.length > 0 || lead.shopPhotoId ? (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>What you learned in the shop</SectionLabel>
          <Card>
            {learned.length > 0 ? (
              <View style={{ gap: 8 }}>
                {learned.map((l) => (
                  <View key={l.label}>
                    <Line label={l.label} value={l.value} />
                    {/* Under the value, never in a list of its own — see
                        `field-check-note.tsx`. A field nobody has checked
                        draws nothing at all, which is the ordinary case and
                        has to stay silent. */}
                    <FieldCheckNote checks={l.finding ? (byFinding.get(l.finding) ?? []) : []} />
                  </View>
                ))}
              </View>
            ) : null}

            {lead.shopPhotoId ? (
              <View style={{ marginTop: learned.length > 0 ? 12 : 0 }}>
                {photo?.uri ? (
                  <Image
                    source={{ uri: photo.uri }}
                    style={{ width: '100%', height: 160, borderRadius: radius.lg }}
                    resizeMode="cover"
                    accessibilityLabel={'The front of ' + title}
                  />
                ) : (
                  /* The file goes the moment the office has the bytes, so a
                     photograph that has synced is no longer on this phone.
                     Saying so is the honest answer; an `<Image>` at a path
                     that no longer exists is a grey rectangle that explains
                     nothing. */
                  <T s="caption">
                    The shop front was photographed. The picture has gone up to the office and is not on this
                    phone any more.
                  </T>
                )}
              </View>
            ) : null}
          </Card>
        </View>
      ) : null}

      {/* ------------------------------------------------- §3 the ladder */}
      {settled ? null : (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>The climb</SectionLabel>
          {/* Every rung of THIS lead's ladder, not a hardcoded six. A salesman
              learns the process from seeing what is above him, which is why
              the whole ladder is drawn rather than only the next step. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 8 }}
            style={{ marginHorizontal: -16, paddingHorizontal: 16 }}>
            {ladder.map((rung) => (
              <Choice
                key={rung}
                label={stageLabel(rung)}
                selected={rung === stage}
                onPress={() => notify(stageSentence(rung))}
                style={{ paddingHorizontal: 14 }}
              />
            ))}
          </ScrollView>

          {/* ------------------------------------------------- §28 the gate */}
          <View style={{ marginTop: 14 }}>
            {next ? (
              <>
                <PrimaryButton
                  label={'Move up to ' + stageLabel(next)}
                  disabled={!gate.open}
                  whyDisabled={
                    gate.open
                      ? undefined
                      : 'Still to do: ' + gate.missing.map((c) => c.says.toLowerCase()).join('; ')
                  }
                  onPress={() => {
                    if (!gate.open) {
                      return notify(gate.missing[0]?.says ?? 'Something is still missing.');
                    }
                    void move(next);
                  }}
                />
                {gate.open ? null : (
                  <View
                    style={{
                      marginTop: 10,
                      borderWidth: 1,
                      borderColor: C.border,
                      borderRadius: radius.lg,
                      backgroundColor: C.surface,
                      padding: 12,
                      gap: 6,
                    }}>
                    <T s="caption">{'Before ' + stageLabel(next) + ', still to do'}</T>
                    {gate.missing.map((c) => (
                      <T key={c.id} style={{ fontSize: 15, lineHeight: 21, color: C.ink }}>
                        {'· ' + c.says}
                      </T>
                    ))}
                  </View>
                )}
              </>
            ) : parked ? (
              /* ON HOLD — NOT LOST, AND NOT FINISHED.
                 There is no rung above a parked lead because it is standing on
                 none: `on_hold` displaces the rung it was on, so the gate
                 refuses to guess and this says so rather than offering the foot
                 of the ladder, which is what the screen used to do — "Move up
                 to Suspect", greyed, on a lead half way up. Coming back is a
                 move to a NAMED rung, and the gate is asked about that rung
                 exactly as it would be on any other move. */
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <T style={[{ flex: 1, minWidth: 0, fontSize: 16, color: C.ink }, weight(600)]}>On hold</T>
                  <Badge tone="amber">Parked</Badge>
                </View>
                <T style={{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 8 }}>
                  {lead.holdReason
                    ? 'Waiting: ' + lead.holdReason
                    : lead.holdReasonCode
                      ? 'Waiting: ' + labelOf(config.holdReasons, lead.holdReasonCode)
                      : 'Nobody wrote down what it is waiting for.'}
                </T>
                {/* THE CODE AS WELL AS THE SENTENCE, where there are both.
                    `holdReason` is what somebody typed and this is the coded
                    answer beside it — the one that can be counted, and the one
                    the office's own reports read. It has come down on the wire
                    since that change landed and was drawn nowhere, so a lead
                    parked from a desk under a named reason read on this phone
                    as one parked for nothing. The label is resolved from the
                    configured list, never printed raw: `budget_issue` on a
                    card is the database talking. */}
                {lead.holdReasonCode && lead.holdReason ? (
                  <T s="caption" style={{ marginTop: 4 }}>
                    {labelOf(config.holdReasons, lead.holdReasonCode)}
                  </T>
                ) : null}
                {/* WHEN IT COMES BACK, said on the record rather than left to
                    the diary field further down the page. A park with a reason
                    and no end date is the state this exists to prevent, so the
                    day it ends belongs beside the reason it started — and a
                    parked lead whose card says nothing about a date reads as
                    one nobody is watching, which is exactly what it would then
                    be. It is `nextFollowUpDate` because that is the one column
                    this phone brings a lead back on: `listLeads` orders by it
                    and `leadAlert` measures lateness from it. */}
                {/* THE OFFICE'S OWN RESUME DATE WINS where it has one.
                    `holdResumeDate` is the day the park was set to end when it
                    was set at a desk, and it now reaches this phone; the
                    follow-up date beside it is the column this app brings a
                    lead back on, which `putOnHold` fills in from the same
                    answer when the park was made here. Where the two disagree
                    the office's is the one somebody decided, so it is the one
                    said out loud — and where only the follow-up exists nothing
                    is lost, because that is how every park made on this phone
                    is stored. */}
                {lead.holdResumeDate ?? lead.nextFollowUpDate ? (
                  <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 6 }, weight(500)]}>
                    {(lead.holdResumeDate ?? lead.nextFollowUpDate!) <= today
                      ? 'It was due back on ' + dmy(lead.holdResumeDate ?? lead.nextFollowUpDate!) + ' — pick it up'
                      : 'Comes back on ' + dmy(lead.holdResumeDate ?? lead.nextFollowUpDate!)}
                  </T>
                ) : (
                  <T style={{ fontSize: 15, lineHeight: 21, color: C.warnInk, marginTop: 6 }}>
                    No day was set for it to come back. Nothing will bring it back to you.
                  </T>
                )}
                <T style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 6 }}>
                  It is not lost and nothing about it has been given up on. Nothing climbs until somebody says
                  which rung it comes back to.
                </T>

                {returning ? (
                  <>
                    <T s="caption" style={{ marginTop: 12 }}>Bring it back to</T>
                    {/* The rungs it can be WORKED at. The end of the ladder is
                        left off: coming back off a hold is picking up where it
                        stopped, and a one-tap jump to Converted on a record
                        that has been stalled for a month is not that. The gate
                        is still asked about whichever rung he picks, in the
                        same words it would use from anywhere else. */}
                    <View style={{ gap: 8, marginTop: 8 }}>
                      {ladder.filter((rung) => !isTerminal(rung)).map((rung) => (
                        <Choice
                          key={rung}
                          label={stageLabel(rung)}
                          sub={stageSentence(rung)}
                          selected={false}
                          onPress={() => {
                            setReturning(false);
                            void move(rung);
                          }}
                          style={{ alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 10 }}
                        />
                      ))}
                    </View>
                    <SecondaryButton
                      label="Leave it on hold"
                      onPress={() => setReturning(false)}
                      style={{ marginTop: 10 }}
                    />
                  </>
                ) : (
                  <PrimaryButton
                    label="Bring it back"
                    onPress={() => setReturning(true)}
                    style={{ marginTop: 14 }}
                  />
                )}
              </Card>
            ) : (
              <Card>
                <T style={{ fontSize: 15, lineHeight: 21, color: C.muted }}>
                  Top of the ladder — there is no rung above this one.
                </T>
              </Card>
            )}
          </View>
        </View>
      )}

      {/* --------------------------------------------------- §24 next action */}
      {settled ? null : (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>What happens next</SectionLabel>
          <Card>
            {lead.nextAction ? (
              <>
                <T style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(500)]}>{lead.nextAction}</T>
                <T s="caption" style={{ marginTop: 4 }}>
                  {[lead.nextActionDate ? pretty(lead.nextActionDate) : null,
                    lead.nextActionOwnerId === me?.id ? 'You' : 'Your lead manager']
                    .filter(Boolean)
                    .join(' · ')}
                </T>
                {lead.nextActionOutcome ? (
                  <T s="small" style={{ color: C.muted, marginTop: 4 }}>
                    {'Expecting: ' + lead.nextActionOutcome}
                  </T>
                ) : null}
              </>
            ) : (
              <T style={{ fontSize: 15, lineHeight: 21, color: C.muted }}>
                Nothing is owed on this lead by anybody. That is how one sits for six weeks.
              </T>
            )}
            <SecondaryButton
              label={lead.nextAction ? 'Change it' : 'Say what happens next'}
              onPress={() => setNextOpen(true)}
              style={{ marginTop: 12 }}
            />
          </Card>
        </View>
      )}

      {/* ------------------------------------------- §5.9 the chain --------

          Drawn only on a shop somebody else invoices, because that is the only
          shape it is true of. See `RelationshipChain` for why it is four boxes
          and why the sentence about commercial authority sits under them. */}
      {lead.thirdParty ? (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>Who this shop goes through</SectionLabel>
          <RelationshipChain
            shopName={title}
            distributorSalesmanName={lead.distributorSalesmanName}
            distributorName={lead.distributorName}
            distributorCount={lead.distributorCount}
            /* The Mahek end of the chain is the lead manager — the seat that
               picks a qualified lead up and runs the conversion. It is the
               person the distributor's own side actually deals with, and it is
               already on the row with its name beside its id, because this
               phone holds no user table to resolve one. */
            salesManagerName={lead.leadManagerName}
          />
        </View>
      ) : null}

      {/* -------------------------------------------------------- the forms */}
      {settled ? null : (
        <View style={{ marginTop: 20, gap: 10 }}>
          <SectionLabel style={{ marginBottom: 0 }}>The work</SectionLabel>

          {/* §5.5 — THE COMMITMENT, and it sits at the TOP of the work.
              It is the one condition in front of `first_order` that is this
              salesman's to satisfy; everything under it on this list is a form
              he fills in earlier on the ladder. Drawn only where the ladder he
              is on actually has that rung: a legacy lead climbs the six this
              app shipped with and a first order is not one of them, so a card
              about it would be a question nobody asked. */}
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

          <SecondaryButton
            label="Prospect details — the eight answers"
            onPress={() => router.push(`/lead-prospect?id=${lead.id}&from=lead`)}
          />
          <SecondaryButton
            label={salesType === 'distributor' ? 'Distributor qualification — thirty questions' : 'Qualification checklist'}
            onPress={() => router.push(`/lead-qualify?id=${lead.id}&from=lead`)}
          />

          {/* §9 §10 — disabled until it is earned, and the title names what is
              outstanding. A sample given to a shop whose application nobody
              understands cannot be reviewed, because nobody knows what a good
              result would look like. */}
          <PrimaryButton
            label="Request a sample"
            disabled={!sampleGate.open}
            whyDisabled={
              sampleGate.open
                ? undefined
                : 'Outstanding: ' + sampleGate.missing.map((c) => c.says.toLowerCase()).join('; ')
            }
            onPress={() => {
              if (!sampleGate.open) {
                return notify(sampleGate.missing[0]?.says ?? 'Not yet.');
              }
              router.push(`/samples?lead=${lead.id}&ask=1&from=lead`);
            }}
          />
          {sampleGate.open ? null : (
            <T s="caption">
              {plural(sampleGate.missing.length, 'thing') + ' still to answer before a sample can go out.'}
            </T>
          )}

          <SecondaryButton
            label={
              lead.thirdParty
                ? 'Billed by ' + (lead.distributorName ?? 'a distributor')
                : 'Who invoices this shop'
            }
            onPress={() => setParties(true)}
          />
          <DashedButton
            label={'Kind of sale: ' + salesTypeLabel(salesType) + ' — change it'}
            onPress={() => setLadderOpen(true)}
          />
        </View>
      )}

      {/* ------------------------------------------------ §10.4 reaching out --

          It sits under the work and above the follow-up date deliberately: it
          is what he DOES between today and the day he goes back, and a panel
          of eleven contact buttons above the qualification forms would read as
          the app suggesting a brochure where it should be asking for answers.

          Drawn only on a live lead, like everything else in this half of the
          screen. Sending a price list to a shop somebody wrote off last month
          is not a thing to make one tap away. */}
      {settled || !comms ? null : (
        <CommunicationPanel
          log={comms}
          onDial={
            lead.mobile
              ? () => {
                  void callNumber(lead.mobile!).then((out) => {
                    if (out.status === 'failed') notify(out.reason);
                  });
                }
              : undefined
          }
          onRecord={(args) => {
            void recordCommunication({ customerId: lead.id, ...args }).then((r) => {
              if (!r.ok) return notify(r.message);
              /* The clock moves on this exactly as it does on a ring from the
                 header: reaching out IS work on the lead, and a record that
                 aged while somebody was working it is how a live shop reaches
                 the staleness sweep. */
              void touchLead(lead.id, today).then(load);
            });
          }}
        />
      )}

      {/* --------------------------------------------------- follow-up */}
      {settled ? null : (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>Go back to them on</SectionLabel>
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
            <T style={{ fontSize: 16, color: lead.nextFollowUpDate ? C.ink : C.faint }}>
              {lead.nextFollowUpDate ? dmy(lead.nextFollowUpDate) : 'Pick a day'}
            </T>
          </Pressable>
        </View>
      )}

      {/* ---------------------------------------------- §E validation calls --

          The office rings the shop the working day after a lead is qualified
          and asks what the visit was actually like. `app/validate.tsx` records
          it, `recordValidation` stores it and sends it — and `validationsFor`,
          written beside them, was called by nothing. So the answers sat in
          `lead_validations` where neither the salesman who raised the lead nor
          the person who made the call could read them back.

          `confirmedRequirement` is the point of the whole exercise: what the
          office was told on the phone, kept apart from what the salesman was
          told standing in the shop, precisely so the two can disagree.

          AND THE OFFICE'S OWN CALLS ARRIVE HERE NOW. This list was every call
          made on THIS PHONE and nothing else — `mbos_lead_validations` went up
          and never came back — so a salesman could not see that the office had
          rung his customer, what they were told, or the one that matters, that
          the requirement he reported had been contradicted. It is the same
          table either way, under the same row id, which is what keeps a call
          made here from appearing twice.

          ALL FOUR FIGURES ARE DRAWN, not the requirement alone. The other
          three are a volume, a competitor and a potential, and each of them is
          a number somebody will quote back at him. Where one disagrees with
          what he has, the disagreement is SAID: it is the single most useful
          thing this call produces, and a screen that prints both figures and
          leaves the reader to notice is a screen that produces it for nobody. */}
      {checks.length ? (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>The office rang them</SectionLabel>
          <View style={{ gap: 10 }}>
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
                <Card key={v.id}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <T style={[{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink }, weight(500)]}>
                      {/* Whether anybody picked up is the first thing worth
                          knowing: a verdict off a call that never connected is
                          a verdict about nothing. */}
                      {v.reached ? 'Spoke to them' : 'Could not reach them'}
                    </T>
                    <Badge tone={tone}>{verdictWord(v.verdict)}</Badge>
                  </View>
                  <T s="caption" style={{ marginTop: 3 }}>
                    {[
                      pretty(isoDate(new Date(v.calledAt))),
                      /* An id is not a person, and the answer to a figure he
                         disagrees with is to ring whoever wrote it down. */
                      v.calledByName,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {v.syncState === 'queued' ? ' · not sent yet' : ''}
                  </T>
                  {told(v, lead).map((t) => (
                    <View key={t.label} style={{ marginTop: 6 }}>
                      <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>
                        {t.label + ': ' + t.said}
                      </T>
                      {/* Drawn only where the two readings differ. A shop that
                          told the office the same thing it told him is a
                          confirmation and reads as one; printing "you had the
                          same" under every agreeing figure is four lines of
                          furniture over the one that is not furniture. */}
                      {t.differsFrom ? (
                        <T s="caption" style={{ marginTop: 1, color: C.muted }}>
                          {'You have: ' + t.differsFrom}
                        </T>
                      ) : null}
                    </View>
                  ))}
                  {v.salesmanFeedback?.trim() ? (
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 6 }}>
                      {'About the visit: ' + v.salesmanFeedback.trim()}
                    </T>
                  ) : null}
                  {/* §8's OTHER ANSWERS, in §8's own words. The call asks
                      seventeen questions and this card drew five, because five
                      was all the wire carried — so the office's own reading of
                      the shop arrived a third told. The ones that decide the
                      next move are among the twelve: whether the SHOP said it
                      was ready for a trial, which is what §5.4 sends a sample
                      on, and whether the objection is the price or the credit,
                      which is what decides what we offer.

                      An unanswered question is LEFT OUT rather than drawn
                      blank. Null is nobody having asked, and a line reading
                      "Any concern about price? —" asserts the shop said no. */}
                  {alsoSaid(v).map((a) => (
                    <View key={a.id} style={{ marginTop: 6 }}>
                      <T s="caption">{a.ask}</T>
                      <T style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 1 }}>
                        {a.said}
                      </T>
                    </View>
                  ))}
                  {v.verdictReason ? (
                    <T style={{ fontSize: 13, lineHeight: 19, color: C.muted, marginTop: 4 }}>
                      {v.verdictReason}
                    </T>
                  ) : null}
                </Card>
              );
            })}
          </View>
        </View>
      ) : null}

      {/* ------------------------------------------------- §25 the timeline */}
      <View style={{ marginTop: 20 }}>
        <SectionLabel style={{ marginBottom: 10 }}>What has happened</SectionLabel>

        {events.length === 0 ? (
          <Card style={{ paddingVertical: 24 }}>
            <T s="small" style={{ color: C.muted, textAlign: 'center' }}>
              Nothing recorded yet. What they buy now, and from whom, is the useful part.
            </T>
          </Card>
        ) : (
          <View style={{ gap: 10 }}>
            {events.map((e) => (
              <Card key={e.id}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[{ fontSize: 15, lineHeight: 22, color: C.ink }, weight(e.kind === 'note' ? 400 : 500)]}>
                      {e.summary}
                    </T>
                    {e.detail ? (
                      <T style={{ fontSize: 14, lineHeight: 20, color: C.muted, marginTop: 2 }}>{e.detail}</T>
                    ) : null}
                    <T s="caption" style={{ marginTop: 4 }}>
                      {[pretty(isoDate(new Date(e.occurredAt))), e.actor].filter(Boolean).join(' · ')}
                    </T>
                  </View>
                </View>
              </Card>
            ))}
          </View>
        )}

        <View style={{ marginTop: 10 }}>
          <VoiceField
            value={note}
            onChangeText={setNote}
            placeholder="Buys 20 cans a month from Asian, wants 45 days credit"
          />
          <PrimaryButton label="Add the note" onPress={saveNote} style={{ marginTop: 10 }} />
        </View>
      </View>

      {/* --------------------------------------------------------- ending */}
      <View style={{ marginTop: 24, gap: 10 }}>
        {settled ? null : (
          <>
            <PrimaryButton label="Convert to customer" onPress={convert} />
            {/* ON HOLD SITS BESIDE LOST, AND THAT PLACEMENT IS THE POINT.
                This is the moment a salesman is standing in front of the two
                answers — the plant is shut for two months, or they are never
                buying — and until now only one of them was on the screen. A
                park drawn anywhere else is a park nobody finds at the moment
                they are reaching for Lost, and Lost is the one that cannot be
                taken back in the reader's mind. It is offered only where the
                lead is still being worked: a parked lead has the card above
                with "Bring it back" on it, and parking a park says nothing. */}
            {parked ? null : (
              <SecondaryButton label="Put it on hold" onPress={() => setHold({ step: 'why' })} />
            )}
            <SecondaryButton label="Mark lost" onPress={() => setLost(true)} />
          </>
        )}
        <DashedButton
          label={lead.archived ? 'Bring it back to the list' : 'Archive it — kept, just out of the way'}
          onPress={() => {
            void setArchived(lead.id, !lead.archived, today).then(() => {
              load();
              notify(lead.archived ? 'Back on the list' : 'Archived — find it under Archived');
            });
          }}
        />
      </View>

      {/* ---------------------------------------------------------- sheets */}
      <BottomSheet open={cal} onClose={() => setCal(false)}>
        <Calendar
          key={cal ? 'open' : 'shut'}
          selected={lead.nextFollowUpDate ?? ''}
          disabledReason={(iso) => (iso < today ? 'That day has gone.' : null)}
          onPick={(iso) => {
            setCal(false);
            void setFollowUp(lead.id, iso, today).then((r) => {
              if (!r.ok) return notify(r.message);
              load();
              notify('Back to them on ' + dmy(iso));
            });
          }}
        />
        <SecondaryButton label="Close" onPress={() => setCal(false)} style={{ minHeight: 48, height: 48, marginTop: 10 }} />
      </BottomSheet>

      {/* §26 — ten reasons, and a sentence beside whichever one it was. */}
      <ReasonSheet
        key={lost ? 'lost-open' : 'lost-shut'}
        open={lost}
        onClose={() => setLost(false)}
        title="Mark this lead lost?"
        body={title + ' stays on the list under Lost, with the reason on it. Nobody rings this shop again after this.'}
        options={config.lostReasons}
        confirmLabel="Mark it lost"
        noteLabel="What they actually said"
        onConfirm={(code, said) => {
          setLost(false);
          void markLost(lead.id, code, said).then((r) => {
            if (!r.ok) return notify(r.message);
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
          ' stops being chased until the day you name. It is not lost, it stays on your list, and nothing about it is given up on.'
        }
        options={config.holdReasons}
        confirmLabel="Next — when does it come back?"
        noteLabel="What they actually said"
        /* Only "Other" costs a sentence. A code meaning "something else" with
           nothing behind it is the one row nobody can act on afterwards, and
           it is the code people reach for when the list does not fit. */
        noteRequiredForCode={REASON_CODE_NEEDING_REMARKS}
        onConfirm={(code, said) => setHold({ step: 'until', code, note: said })}
      />

      <BottomSheet open={hold?.step === 'until'} onClose={() => setHold(null)} scroll>
        <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
          When does it come back?
        </T>
        <T s="caption" style={{ marginTop: 2 }}>
          {/* The sentence says what the date DOES, because a date on a screen
              that does nothing is how "back after Diwali" became a lead nobody
              looked at for six months. */}
          On this day it returns to your list with the action you set next.
        </T>
        <View style={{ marginTop: 14 }}>
          <Calendar
            key={hold?.step === 'until' ? 'hold-cal-open' : 'hold-cal-shut'}
            selected=""
            /* Today is refused rather than merely past days: a hold that ends
               on the day it is made is not a hold, and the screen saying so is
               kinder than a park that quietly means nothing. */
            disabledReason={(iso) =>
              iso <= today ? 'A hold has to end after today, or it is not a hold.' : null
            }
            onPick={(iso) =>
              setHold((h) => (h?.step === 'until' ? { step: 'next', code: h.code, note: h.note, until: iso } : h))
            }
          />
        </View>
        <SecondaryButton
          label="Cancel"
          onPress={() => setHold(null)}
          style={{ minHeight: 48, height: 48, marginTop: 10, borderRadius: radius.xl }}
        />
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
              if (!r.ok) return notify(r.message);
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
        current={{ action: lead.nextAction, date: lead.nextActionDate, ownerId: lead.nextActionOwnerId }}
        onSave={(n) => {
          setNextOpen(false);
          void setNextAction(lead.id, n).then((r) => {
            if (!r.ok) return notify(r.message);
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
            if (!r.ok) return notify(r.message);
            load();
            notify(salesTypeLabel(t) + ' — back to the foot of that ladder');
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
              if (!r.ok) return notify(r.message);
              load();
              /* The confirmation says what it DID and, in the same breath, what
                 it did not: a salesman who has just written down a promise will
                 reasonably look for the ladder to have moved. */
              notify(plural(c.quantityCans, 'can') + ' expected ' + dmy(c.date) + ' — noted, not ordered');
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
            if (!r.ok) return notify(r.message);
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
            ? 'It closes with the reason on it, and stays on the list under Lost.'
            : 'Your sales manager comes onto it from here, and rings the customer to check.'
        }
        options={asking === 'not' ? view.config.lostReasons : view.config.prospectReasons}
        confirmLabel={asking === 'not' ? 'Close it' : 'Make it a Prospect'}
        noteLabel="What they said"
        onConfirm={(code, said) => {
          const wanted = asking === 'prospect';
          setSuspect(null);
          void decideSuspect(view.lead.id, { prospect: wanted, reasonCode: code, note: said }).then((r) => {
            if (!r.ok) return notify(r.message);
            load();
            notify(wanted ? 'Now a Prospect' : 'Closed');
          });
        }}
      />
    );
  }
}

/** A label and a value on one line — the record's own small table. */
function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
      <T s="caption" style={{ width: 120 }}>{label}</T>
      <T style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink }}>{value}</T>
    </View>
  );
}

/**
 * §2 — changing which ladder a lead is on, which is not a chip beside the
 * stage.
 *
 * It comes back to the foot of the new ladder and it says so before it does,
 * because the rung it was standing on may not exist over there — and a lead
 * left on a rung that is not on its ladder is a record with no button and no
 * explanation.
 */
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
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        What kind of sale is this?
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        It decides which questions the rest of the funnel asks. Changing it starts the climb again at the foot.
      </T>

      {/* The same withdrawal as the raise screen, and it bites hardest here:
          this sheet is the one place a lead could be MOVED onto the
          distributor ladder. The server refuses it too, because an APK cannot
          be recalled and an older build goes on drawing the chip. A lead
          already on that ladder is untouched — it sits at `current`, the
          button below is disabled while `picked === current`, and nothing here
          takes it off. */}
      <View style={{ gap: 8, marginTop: 14 }}>
        {offeredSalesTypes().map((t) => (
          <Choice
            key={t.code}
            label={t.label}
            sub={t.hint}
            selected={picked === t.code}
            onPress={() => setPicked(t.code)}
            style={{ alignItems: 'flex-start', paddingHorizontal: 14, paddingVertical: 10 }}
          />
        ))}
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Why it is changing</SectionLabel>
        <Input value={reason} onChangeText={setReason} placeholder="Optional — he sells on rather than uses it" />
      </View>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label="Change it"
          disabled={!picked || picked === current}
          whyDisabled={!picked ? 'Pick one first.' : 'That is what it is already.'}
          onPress={() => picked && picked !== current && onPick(picked, reason)}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}

/**
 * §23 — who invoices this shop, and who at the distributor calls on it.
 *
 * Both are asked on the lead rather than reconstructed at conversion, because
 * the answer is known on the first visit and nobody remembers it three months
 * later. The distributor is picked from the accounts on this handset — a shop
 * we deliver to is not holding the invoice and cannot be somebody's
 * distributor, which the picker enforces by only ever offering customers.
 *
 * The distributor's own salesman is a NAME. He has no MahekOne login and never
 * will, exactly like the CRM's `sales_manager_person_name`, so a box that
 * insisted on picking him from a list would have nothing in it.
 */
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
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        Who invoices this shop?
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        A shop we deliver to and do not bill is a third-party customer, and it has to say who does.
      </T>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
        <Choice label="We do" selected={!thirdParty} onPress={() => setThirdParty(false)} style={{ paddingHorizontal: 16 }} />
        <Choice label="A distributor does" selected={thirdParty} onPress={() => setThirdParty(true)} style={{ paddingHorizontal: 16 }} />
      </View>

      {thirdParty ? (
        <>
          <View style={{ marginTop: 14 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Which distributor</SectionLabel>
            <Input value={query} onChangeText={setQuery} placeholder="Search your accounts" />
            <View style={{ gap: 8, marginTop: 8 }}>
              {hits.map((h) => (
                <Choice
                  key={h.id}
                  label={h.name}
                  sub={h.city ?? undefined}
                  selected={chosen?.id === h.id}
                  onPress={() => setChosen({ id: h.id, name: h.name })}
                  style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
                />
              ))}
              {hits.length === 0 ? (
                <T s="caption">Nothing matched. Only accounts we invoice can be named here.</T>
              ) : null}
            </View>
          </View>

          <View style={{ marginTop: 12 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Their salesman for this shop</SectionLabel>
            <Input value={salesman} onChangeText={setSalesman} placeholder="Rahul — the man who actually calls on them" />
            <T s="caption" style={{ marginTop: 6 }}>
              A name is enough. He has no login here and does not need one.
            </T>
          </View>
        </>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label="Save"
          disabled={thirdParty && !chosen}
          whyDisabled="Say which distributor invoices this shop — a marked shop with nobody billing it is a record nobody can ask about."
          onPress={() => {
            if (thirdParty && !chosen) return;
            onSave({
              thirdParty,
              distributorCustomerId: thirdParty ? chosen?.id ?? null : null,
              distributorName: thirdParty ? chosen?.name ?? null : null,
              distributorSalesmanName: thirdParty ? salesman.trim() || null : null,
            });
          }}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}

/**
 * The stored verdict, in words somebody would say.
 *
 * `not_qualified` on a badge is the database talking. Anything unrecognised
 * falls through to "Waiting" rather than being printed raw — a verdict added
 * at a desk should read as pending on an older handset, not as an enum.
 */
/**
 * §8 — WHAT THE SHOP TOLD THE OFFICE, beside what it told him.
 *
 * The four `confirmed*` figures are never written over the lead's own columns,
 * at either end, and the schema says why at length: what the salesman was told
 * standing in the shop and what the office was told on the phone are two
 * readings of one shop, and the whole value of the call is that they can
 * disagree. This is the reading back — the half that had no screen.
 *
 * The second line is drawn ONLY WHERE THEY DIFFER. A figure the shop repeated
 * is a confirmation and reads as one; printing "you have the same" under all
 * four would bury the one row that is not furniture, which is the same mistake
 * the microphone made when it was drawn at the weight of the resize grip.
 *
 * A figure the office did not ask about is left out entirely rather than drawn
 * as a blank. Null here is nobody having asked, not the shop having said
 * nothing — and a row saying "Gets through: —" asserts the second.
 */
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
      label: 'Gets through',
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
      label: 'Could be worth',
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

function verdictWord(v: string): string {
  switch (v) {
    case 'confirmed': return 'Confirmed';
    case 'not_qualified': return 'Not qualified';
    case 'on_hold': return 'On hold';
    default: return 'Waiting';
  }
}
