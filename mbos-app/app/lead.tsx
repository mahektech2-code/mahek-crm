import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { Icon } from '../src/components/ui/Icon';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { NextActionSheet } from '../src/components/leads/next-action-sheet';
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
import { validationsFor } from '../src/data/validations';
import { callNumber } from '../src/lib/messaging';
import {
  addLeadNote,
  advanceStage,
  decideSuspect,
  distributorCandidates,
  leadEvents,
  leadFunnelView,
  markLost,
  setLeadParties,
  setNextAction,
  setSalesType,
  type LeadEvent,
  type LeadFunnelView,
} from '../src/data/lead-funnel';
import { currentSession } from '../src/data/session';
import { leadAlert, type LeadThresholds } from '../src/engines/leads';
import {
  gateTo,
  ladderFor,
  SALES_TYPES,
  salesTypeLabel,
  stageLabel,
  stageSentence,
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

  const [checks, setChecks] = React.useState<Awaited<ReturnType<typeof validationsFor>>>([]);

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
    ]).then(([v, e, t, s, calls]) => {
      if (!live) return;
      setView(v);
      setEvents(e);
      setCfg(t);
      setMe(s ? { id: s.user.id, name: s.user.name } : null);
      setChecks(calls);
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
  const title = lead.company?.trim() || lead.name;

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
          <Badge tone={STAGE_TONE[lead.stage] ?? 'neutral'}>{stageLabel(stage)}</Badge>
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
          <Line label="Visits" value={plural(visits, 'visit')} />
          <Line label="Next follow-up" value={lead.nextFollowUpDate ? pretty(lead.nextFollowUpDate) : 'None set'} />
        </View>

        {alert ? (
          <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.warnInk }, weight(500)]}>{alert}</T>
        ) : null}

        {stage === 'lost' && lead.lostReason ? (
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.danger }}>{'Lost — ' + lead.lostReason}</T>
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

      {/* -------------------------------------------------------- the forms */}
      {settled ? null : (
        <View style={{ marginTop: 20, gap: 10 }}>
          <SectionLabel style={{ marginBottom: 0 }}>The work</SectionLabel>

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
          told standing in the shop, precisely so the two can disagree. */}
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
                    {pretty(isoDate(new Date(v.calledAt)))}
                    {v.syncState === 'queued' ? ' · not sent yet' : ''}
                  </T>
                  {v.confirmedRequirement ? (
                    <T style={{ fontSize: 14, lineHeight: 20, color: C.body, marginTop: 6 }}>
                      {'They told the office: ' + v.confirmedRequirement}
                    </T>
                  ) : null}
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

      <View style={{ gap: 8, marginTop: 14 }}>
        {SALES_TYPES.map((t) => (
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
function verdictWord(v: string): string {
  switch (v) {
    case 'confirmed': return 'Confirmed';
    case 'not_qualified': return 'Not qualified';
    case 'on_hold': return 'On hold';
    default: return 'Waiting';
  }
}
