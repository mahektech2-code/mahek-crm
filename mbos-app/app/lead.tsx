import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import {
  addNote,
  convertToCustomer,
  getLead,
  leadThresholds,
  notesOf,
  setArchived,
  setFollowUp,
  setStage,
  type Lead,
  type LeadNote,
} from '../src/data/leads';
import { leadAlert, type LeadThresholds } from '../src/engines/leads';
import { dmy, inr, isoDate, pretty } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * One lead.
 *
 * Two of the buttons here cannot be taken back and both say so before they
 * run. Converting writes a customer this phone owns and links the two records
 * for good; marking it Lost asks why, because after that nobody rings this
 * shop again and the reason is the only thing the record is still worth.
 *
 * Everything else — a stage, a note, a date — is the ordinary progress of a
 * conversation and asks nothing.
 */

const STAGES = ['New', 'Contacted', 'Qualified', 'Negotiation'] as const;

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

  const [lead, setLead] = React.useState<Lead | null>(null);
  /* Null until the thresholds arrive from configuration. A default written in
     here would be a business rule living in a screen, and the sentence it
     produced would be wrong on any handset whose office had changed it. */
  const [cfg, setCfg] = React.useState<LeadThresholds | null>(null);
  const [today] = React.useState(() => isoDate(new Date()));
  const [note, setNote] = React.useState('');
  const [cal, setCal] = React.useState(false);

  const load = React.useCallback(() => {
    let live = true;
    if (!id) return;
    void Promise.all([getLead(id), leadThresholds()]).then(([l, t]) => {
      if (!live) return;
      setLead(l);
      setCfg(t);
    });
    return () => {
      live = false;
    };
  }, [id]);

  useFocusEffect(load);

  if (!lead) {
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

  const notes: LeadNote[] = notesOf(lead);
  const alert = cfg ? leadAlert(lead, today, cfg) : null;
  const settled = lead.stage === 'Converted' || lead.stage === 'Lost';

  const move = async (stage: string) => {
    const r = await setStage(lead.id, stage, null, today);
    if (!r.ok) return notify(r.message);
    load();
    notify(stage);
  };

  const saveNote = async () => {
    const r = await addNote(lead.id, note, today);
    if (!r.ok) return notify(r.message);
    setNote('');
    load();
    notify('Noted');
  };

  const markLost = () =>
    askConfirm({
      title: 'Mark this lead lost?',
      body: (lead.company?.trim() || lead.name) + ' stays on the list under Lost, with your reason on it.',
      reasonLabel: 'Why · required',
      confirmLabel: 'Mark it lost',
      run: (reason) => {
        void setStage(lead.id, 'Lost', reason, today).then((r) => {
          if (!r.ok) return notify(r.message);
          load();
          notify('Lost · ' + reason);
        });
      },
    });

  const convert = () =>
    askConfirm({
      title: 'Make them a customer?',
      body:
        (lead.company?.trim() || lead.name) +
        ' becomes an account you can order against. The lead stays, linked to it, and this cannot be undone.',
      confirmLabel: 'Convert',
      run: () => {
        void convertToCustomer(lead, today).then((r) => {
          if (!r.ok) return notify(r.message);
          notify('Customer created · ' + (lead.company?.trim() || lead.name));
          set({ custId: r.value, pTab: 0 });
          router.push('/customer');
        });
      },
    });

  return (
    <AppFrame title="Lead" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* ---------------------------------------------------------- who */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]}>
              {lead.company?.trim() || lead.name}
            </T>
            <T s="caption" style={{ marginTop: 2 }}>
              {[lead.company?.trim() ? lead.name : null, lead.city, lead.source].filter(Boolean).join(' · ')}
            </T>
          </View>
          <Badge tone={STAGE_TONE[lead.stage] ?? 'neutral'}>{lead.stage}</Badge>
        </View>

        <Divider style={{ marginVertical: 12 }} />

        <View style={{ gap: 8 }}>
          <Line label="Mobile" value={lead.mobile ?? 'Not taken'} />
          <Line
            label="Might buy"
            value={lead.estimatedPotentialPaise ? inr(lead.estimatedPotentialPaise / 100) + ' a month' : 'Not estimated'}
          />
          <Line label="Next follow-up" value={lead.nextFollowUpDate ? pretty(lead.nextFollowUpDate) : 'None set'} />
          <Line label="Last anything" value={lead.lastActivityDate ? pretty(lead.lastActivityDate) : '—'} />
        </View>

        {alert ? (
          <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.warnInk }, weight(500)]}>{alert}</T>
        ) : null}

        {lead.stage === 'Lost' && lead.lostReason ? (
          <T style={{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.danger }}>{'Lost — ' + lead.lostReason}</T>
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

      {/* -------------------------------------------------------- stages */}
      {settled ? null : (
        <View style={{ marginTop: 20 }}>
          <SectionLabel style={{ marginBottom: 10 }}>Where it stands</SectionLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {STAGES.map((s) => (
              <Choice
                key={s}
                label={s}
                selected={lead.stage === s}
                onPress={() => move(s)}
                style={{ paddingHorizontal: 16 }}
              />
            ))}
          </View>
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

      {/* ----------------------------------------------------------- notes */}
      <View style={{ marginTop: 20 }}>
        <SectionLabel style={{ marginBottom: 10 }}>What was said</SectionLabel>

        {notes.length === 0 ? (
          <Card style={{ paddingVertical: 24 }}>
            <T s="small" style={{ color: C.muted, textAlign: 'center' }}>
              Nothing written down yet. What they buy now, and from whom, is the useful part.
            </T>
          </Card>
        ) : (
          <View style={{ gap: 10 }}>
            {notes
              .slice()
              .reverse()
              .map((n, i) => (
                <Card key={String(n.at) + '-' + i}>
                  <T style={{ fontSize: 15, lineHeight: 22, color: C.ink }}>{n.text}</T>
                  {n.at ? <T s="caption" style={{ marginTop: 4 }}>{pretty(isoDate(new Date(n.at)))}</T> : null}
                </Card>
              ))}
          </View>
        )}

        <View style={{ marginTop: 10 }}>
          <Input
            value={note}
            onChangeText={setNote}
            placeholder="Buys 20 cans a month from Asian, wants 45 days credit"
            multiline
          />
          <PrimaryButton label="Add the note" onPress={saveNote} style={{ marginTop: 10 }} />
        </View>
      </View>

      {/* --------------------------------------------------------- ending */}
      <View style={{ marginTop: 24, gap: 10 }}>
        {settled ? null : (
          <>
            <PrimaryButton label="Convert to customer" onPress={convert} />
            <SecondaryButton label="Mark lost" onPress={markLost} />
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
    </AppFrame>
  );
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
