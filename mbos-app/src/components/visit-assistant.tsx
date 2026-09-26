import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { color as C, radius, type, weight } from '../theme/tokens';
import { Icon } from './ui/Icon';
import { Card, Choice, PrimaryButton, SecondaryButton } from './ui/primitives';
import { useOnline } from './ui/dictate';
import { getConfig } from '../data/config';
import { visitAssist } from '../sync/api';
import { pretty } from '../lib/format';
import {
  openQuestions,
  type VisitAction,
  type VisitAnalysis,
} from '../engines/visit-assist';

/**
 * "WHAT HAPPENED IN THE SHOP?" — said once, and the visit fills itself in.
 *
 * The handset's counterpart to the CRM call assistant. The salesman speaks
 * about the visit into the note's microphone (any language) or types it, and
 * presses one button. MahekOne reads it and this card shows what it
 * understood: the outcome, the day to come back, and each follow-on the visit
 * implies — an order with its lines, money handed over, a complaint, a
 * sample, a lead's requirement.
 *
 * NOTHING HERE SAVES. "Fill the visit" puts the outcome and the day into the
 * form where he has not answered them himself; each follow-on opens its OWN
 * ordinary form, filled in, for him to read and submit exactly as he would
 * have by hand. The visit's Save is still the only thing that records the
 * visit. That is the client's rule, and the only honest shape for something
 * that is guessing from speech.
 *
 * UNSURE MEANS ASK, and the card looks like it: a question has chips, never a
 * filled field. An open complaint or sample like the one proposed is NAMED
 * rather than offered twice.
 *
 * NEEDS SIGNAL, and says so before it is pressed. A proposal that arrived
 * tomorrow would be a suggestion about a visit already saved, so unlike the
 * visit itself this is never queued.
 */

export type VisitAssistantHandlers = {
  /** "Fill the visit" — the screen decides what is still empty. */
  onFill: (analysis: VisitAnalysis) => void;
  onChooseOutcome: (key: string) => void;
  onChooseDate: (iso: string) => void;
  /** `picked` is the product he chose for a line the assistant was unsure of. */
  onOrder: (action: Extract<VisitAction, { kind: 'order' }>, picked: Record<number, string>) => void;
  onPayment: (action: Extract<VisitAction, { kind: 'payment' }>) => void;
  onComplaint: (action: Extract<VisitAction, { kind: 'complaint' }>) => void;
  onSample: (action: Extract<VisitAction, { kind: 'sample' }>) => void;
  onRequirement: (action: Extract<VisitAction, { kind: 'requirement' }>) => void;
  onDecision: (decision: 'qualified' | 'lost') => void;
  /** The reading this visit was filled from, carried on the save. */
  onDraft: (draftId: string | null) => void;
};

export function useVisitAssistantAvailable(): boolean {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    void getConfig<{ available?: boolean } | null>('mbos.ai.visitAssistant', null).then((cfg) => {
      if (live) setOn(cfg?.available === true);
    });
    return () => {
      live = false;
    };
  }, []);
  return on;
}

const STATE_WORD: Record<string, { text: string; fg: string; bg: string }> = {
  ready: { text: 'Filled in — check it', fg: C.success, bg: C.successBg },
  confirm: { text: 'Needs you', fg: C.warnInk, bg: C.warnBg },
  duplicate: { text: 'Already on record', fg: C.info, bg: C.infoBg },
};

function StatePill({ state }: { state: string }) {
  const w = STATE_WORD[state] ?? STATE_WORD.confirm;
  return (
    <View style={{ backgroundColor: w.bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={[{ fontSize: 12, color: w.fg }, weight(600)]}>{w.text}</Text>
    </View>
  );
}

function Questions({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <View style={{ marginTop: 6, gap: 2 }}>
      {items.map((q) => (
        <Text key={q} style={[type.caption, { color: C.warnInk }]}>
          {'• ' + q}
        </Text>
      ))}
    </View>
  );
}

export function VisitAssistant({
  customerId,
  note,
  heard,
  handlers,
}: {
  customerId: string;
  /** What is in the note box now — typed, dictated, or corrected. */
  note: string;
  /** The last dictation, in the language it was spoken in. */
  heard: { spoken: string; english: string; language: string | null } | null;
  handlers: VisitAssistantHandlers;
}) {
  const available = useVisitAssistantAvailable();
  const online = useOnline();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<VisitAnalysis | null>(null);
  /* Read on which note — a changed note is a changed question, so the card
     says its answer is about an older version rather than silently standing. */
  const [readNote, setReadNote] = React.useState('');
  const [picked, setPicked] = React.useState<Record<number, string>>({});

  if (!available) return null;

  const text = note.trim();
  const stale = !!result && readNote !== text;

  const read = async () => {
    if (busy || !text) return;
    setBusy(true);
    setError(null);
    try {
      /* The dictation's original words go with it only while they still
         belong to the note — once he has rewritten the box by hand, the
         spoken version describes a note that no longer exists. */
      const spokenStill = heard && text.includes(heard.english.trim()) ? heard : null;
      const out = await visitAssist({
        customerId,
        spoken: spokenStill?.spoken ?? '',
        english: spokenStill?.english ?? '',
        typedNote: text,
        language: spokenStill?.language ?? null,
        heardBy: spokenStill ? 'dictated' : 'typed',
      });
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setResult(out.analysis);
      setReadNote(text);
      setPicked({});
      handlers.onDraft(out.draftId);
    } finally {
      setBusy(false);
    }
  };

  const whyOff = !text
    ? 'Say or type what happened first — the note box above.'
    : !online
      ? 'No signal — fill the visit yourself. Your note is kept either way.'
      : undefined;

  return (
    <Card style={{ marginTop: 12, borderWidth: 1, borderColor: C.primaryEdge }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="spark" size={18} color={C.primaryDeep} strokeWidth={1.8} />
        <Text style={[type.h3, { flex: 1 }]}>Understand this visit</Text>
      </View>

      {!result ? (
        <Text style={[type.caption, { marginTop: 6 }]}>
          Say what happened in the shop, in any language — MahekOne fills the visit and lines up
          what comes next. You check everything; nothing saves until you press Save.
        </Text>
      ) : null}

      {result ? <Proposal result={result} picked={picked} setPicked={setPicked} handlers={handlers} /> : null}

      {stale ? (
        <Text style={[type.caption, { marginTop: 10, color: C.warnInk }]}>
          The note has changed since this was read. Read it again to include what you added.
        </Text>
      ) : null}
      {error ? <Text style={[type.caption, { marginTop: 10, color: C.warnInk }]}>{error}</Text> : null}

      <View style={{ marginTop: 12 }}>
        {result && !stale ? (
          <PrimaryButton
            label="Fill the visit"
            onPress={() => handlers.onFill(result)}
          />
        ) : (
          <PrimaryButton
            label={busy ? 'Reading…' : result ? 'Read it again' : 'Read my note'}
            onPress={() => void read()}
            disabled={busy || !!whyOff}
            whyDisabled={busy ? 'Reading what you said.' : whyOff}
          />
        )}
      </View>
      {result && !stale ? (
        <View style={{ marginTop: 8 }}>
          <SecondaryButton label={busy ? 'Reading…' : 'Read it again'} onPress={() => void read()} />
        </View>
      ) : null}
    </Card>
  );
}

function Proposal({
  result,
  picked,
  setPicked,
  handlers,
}: {
  result: VisitAnalysis;
  picked: Record<number, string>;
  setPicked: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  handlers: VisitAssistantHandlers;
}) {
  const waiting = openQuestions(result);
  return (
    <View style={{ marginTop: 8 }}>
      {result.summary ? <Text style={[type.bodyInk, { marginBottom: 4 }]}>{result.summary}</Text> : null}
      <Text style={type.caption}>
        {waiting === 0 ? 'Nothing needs you — check it and fill the visit.' : `${waiting} thing${waiting === 1 ? '' : 's'} to answer below.`}
      </Text>
      {result.notes.map((n) => (
        <Text key={n} style={[type.caption, { marginTop: 4 }]}>
          {n}
        </Text>
      ))}

      {/* ---- the outcome ---- */}
      {result.outcome ? (
        <Section title="Save it as">
          {result.outcome.state === 'ready' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[type.bodyInk, weight(600), { flex: 1 }]}>{result.outcome.label}</Text>
              <StatePill state="ready" />
            </View>
          ) : (
            <View>
              <Text style={[type.small, { color: C.warnInk }]}>Which was it?</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {result.outcomeChoices.map((o) => (
                  <Choice key={o.key} label={o.label} selected={false} onPress={() => handlers.onChooseOutcome(o.key)} />
                ))}
              </View>
            </View>
          )}
          <Text style={[type.caption, { marginTop: 4 }]}>{result.outcome.why}</Text>
        </Section>
      ) : null}

      {/* ---- come back ---- */}
      {result.comeBack ? (
        <Section title="Come back on">
          {result.comeBack.date ? (
            <Text style={[type.bodyInk, weight(600)]}>{pretty(result.comeBack.date)}</Text>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {result.comeBack.choices.map((c) => (
                <Choice key={c.date} label={c.label} selected={false} onPress={() => handlers.onChooseDate(c.date)} />
              ))}
            </View>
          )}
          {result.comeBack.explanation ? (
            <Text style={[type.caption, { marginTop: 4 }]}>{result.comeBack.explanation}</Text>
          ) : null}
        </Section>
      ) : null}

      {/* ---- what comes next ---- */}
      {result.actions.length ? (
        <Section title="What comes next">
          <View style={{ gap: 12 }}>
            {result.actions.map((a, i) => (
              <ActionRow key={a.kind + i} action={a} picked={picked} setPicked={setPicked} handlers={handlers} />
            ))}
          </View>
        </Section>
      ) : null}

      <Questions items={result.questions} />

      {result.competitor || result.feedback.length ? (
        <Section title="For your manager">
          {result.competitor ? <Text style={type.small}>{'Competitor named: ' + result.competitor}</Text> : null}
          {result.feedback.map((f) => (
            <Text key={f.text} style={type.small}>
              {(f.tone === 'negative' ? '▾ ' : f.tone === 'positive' ? '▴ ' : '• ') + f.text}
            </Text>
          ))}
          <Text style={[type.caption, { marginTop: 4 }]}>Keep it in the note if it matters — the office reads the note.</Text>
        </Section>
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.hairline }}>
      <Text style={[type.label, { marginBottom: 6 }]}>{title}</Text>
      {children}
    </View>
  );
}

function DoorButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        marginTop: 8,
        minHeight: 44,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: C.primary,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
      }}>
      <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(600)]}>{label}</Text>
    </Pressable>
  );
}

function ActionRow({
  action: a,
  picked,
  setPicked,
  handlers,
}: {
  action: VisitAction;
  picked: Record<number, string>;
  setPicked: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  handlers: VisitAssistantHandlers;
}) {
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[type.bodyInk, weight(600), { flex: 1 }]}>{a.title}</Text>
        <StatePill state={a.state} />
      </View>
      <Text style={[type.caption, { marginTop: 2 }]}>{a.why}</Text>

      {a.kind === 'order'
        ? a.lines.map((l, i) => (
            <View key={l.said + i} style={{ marginTop: 6 }}>
              <Text style={type.small}>
                {(l.product.state === 'matched' ? l.product.name : `"${l.said}"`) +
                  (l.quantityCans != null ? ` · ${l.quantityCans} cans` : l.saidAs ? ` · said ${l.saidAs}` : ' · quantity?')}
              </Text>
              {l.product.state === 'ambiguous' ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {l.product.options.map((o) => (
                    <Choice
                      key={o.productId}
                      label={o.name}
                      selected={picked[i] === o.productId}
                      onPress={() => setPicked((p) => ({ ...p, [i]: o.productId }))}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ))
        : null}
      {a.kind === 'promise' && a.date?.date ? (
        <Text style={[type.small, { marginTop: 4 }]}>{'They will pay on ' + pretty(a.date.date)}</Text>
      ) : null}
      {a.kind === 'requirement' ? (
        <Text style={[type.small, { marginTop: 4 }]}>
          {[a.what, a.monthlyLitres != null ? `${a.monthlyLitres} L a month` : null, a.cans != null ? `${a.cans} cans` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      ) : null}

      <Questions items={a.state === 'duplicate' ? [] : a.questions} />

      {a.state === 'duplicate' ? null : a.kind === 'order' ? (
        <DoorButton label="Put it in the cart and open the order" onPress={() => handlers.onOrder(a, picked)} />
      ) : a.kind === 'payment' ? (
        <DoorButton label="Open the receipt, filled in" onPress={() => handlers.onPayment(a)} />
      ) : a.kind === 'complaint' ? (
        <DoorButton label="Open the complaint, filled in" onPress={() => handlers.onComplaint(a)} />
      ) : a.kind === 'sample' ? (
        <DoorButton label="Open the sample request, filled in" onPress={() => handlers.onSample(a)} />
      ) : a.kind === 'requirement' ? (
        <DoorButton label="Fill the requirement" onPress={() => handlers.onRequirement(a)} />
      ) : a.kind === 'lead_decision' && a.decision ? (
        <DoorButton
          label={a.decision === 'qualified' ? 'Mark it "A prospect"' : 'Mark it "Lost"'}
          onPress={() => handlers.onDecision(a.decision as 'qualified' | 'lost')}
        />
      ) : null}
    </View>
  );
}
