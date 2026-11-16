import React from 'react';
import { Pressable, View, Text } from 'react-native';
import { color as C, type, weight } from '../theme/tokens';
import { Icon, type IconName } from './ui/Icon';
import { PillButton } from './ui/v3';
import { useOnline } from './ui/dictate';
import { PressableScale, Presence, Stagger, Swap } from './ui/motion';
import { feedback } from './ui/feedback';
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

/*
 * The words and colours of a proposal's state. Version 3 draws them as small
 * tinted pills; the navy card's tiles and the white cards below it share them.
 */
const STATE_WORD: Record<string, { text: string; fg: string; bg: string }> = {
  ready: { text: 'Filled in · check', fg: C.success, bg: C.successBg },
  confirm: { text: 'Needs you', fg: C.warnInk, bg: C.warnBg },
  duplicate: { text: 'Already saved', fg: C.info, bg: C.infoBg },
};

/** The glyph for each outcome — the visit form's grid and the "Save it as" tile. */
export const OUTCOME_ICON: Record<string, IconName> = {
  visited: 'visit',
  order: 'order',
  payment: 'money',
  complaint: 'alert',
  sample: 'sample',
  closed_now: 'person',
  closed: 'lock',
};

/** The glyph for each kind of follow-on the reading proposes. */
const ACTION_ICON: Record<VisitAction['kind'], IconName> = {
  order: 'order',
  payment: 'money',
  promise: 'cal',
  complaint: 'alert',
  sample: 'sample',
  opportunity: 'spark',
  requirement: 'list',
  lead_decision: 'person',
};

function StatePill({ state }: { state: string }) {
  const w = STATE_WORD[state] ?? STATE_WORD.confirm;
  return (
    <View style={{ backgroundColor: w.bg, borderRadius: 13, height: 26, paddingHorizontal: 10, justifyContent: 'center', alignSelf: 'flex-start' }}>
      <Text style={[{ fontSize: 12, color: w.fg }, weight(800)]}>{w.text}</Text>
    </View>
  );
}

function Questions({ items, onNavy = false }: { items: string[]; onNavy?: boolean }) {
  if (!items.length) return null;
  return (
    <View style={{ marginTop: 6, gap: 2 }}>
      {items.map((q) => (
        <Text key={q} style={{ fontSize: 13, lineHeight: 18, color: onNavy ? '#FFC24A' : C.warnInk }}>
          {'• ' + q}
        </Text>
      ))}
    </View>
  );
}

/** A small pill chip — a question's answer, tapped to choose it. */
function Chip({
  label,
  selected,
  onPress,
  onNavy = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  onNavy?: boolean;
}) {
  return (
    <Pressable
      onPress={() => {
        feedback('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 18,
        justifyContent: 'center',
        backgroundColor: selected ? C.navy : onNavy ? C.surface : C.wash,
        opacity: pressed ? 0.8 : 1,
      })}>
      <Text style={[{ fontSize: 13, color: selected ? '#FFFFFF' : C.ink }, weight(700)]}>{label}</Text>
    </Pressable>
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
      /* A reading takes seconds over a thin connection, and he has usually
         looked back up at the shopkeeper by the time it answers — so the
         answer is felt as well as drawn, either way. */
      if (!out.ok) {
        setError(out.error);
        feedback('error');
        return;
      }
      feedback('success');
      setResult(out.analysis);
      setReadNote(text);
      setPicked({});
      handlers.onDraft(out.draftId);
    } finally {
      setBusy(false);
    }
  };

  const whyOff = !text
    ? 'First say or type what happened, in the note box above.'
    : !online
      ? 'No signal. Fill the visit yourself. Your note is safe.'
      : undefined;

  const waiting = result ? openQuestions(result) : 0;

  return (
    <View style={{ marginTop: 12 }}>
      {/* THE NAVY CARD. Version 3 sets the assistant apart from the form it
          fills: what it read sits in the dark card, and what it proposes to
          do next follows as ordinary white cards underneath. */}
      <View style={{ backgroundColor: C.navy, borderRadius: 22, padding: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="spark" size={18} color={C.lime} strokeWidth={2} />
          <Text style={[{ fontSize: 15, color: C.lime, flex: 1 }, weight(800)]} accessibilityRole="header">
            Understand this visit
          </Text>
          {result && waiting > 0 ? (
            <View style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.warnBg, justifyContent: 'center' }}>
              <Text style={[{ fontSize: 12, color: C.warnInk }, weight(800)]}>{waiting + ' to answer'}</Text>
            </View>
          ) : null}
        </View>

        <Presence show={!result}>
          <Text
            style={{ fontSize: 13, lineHeight: 18, color: '#DCE3EE', marginTop: 6 }}
            accessibilityHint="Say what happened in the shop, in any language. MahekOne fills the visit and the next steps. You check everything. Nothing saves until you press Save.">
            Fills the visit and next steps from your note, in any language. You check. Nothing saves until Save.
          </Text>
        </Presence>

        {/* The proposal opens in place of the explanation, and a second reading
            replaces the first in place — keyed on the note it was read from, so
            "Read it again" visibly lands a new answer rather than a same-looking
            card that may or may not have changed. */}
        <Presence show={!!result}>
          {result ? (
            <Swap id={readNote}>
              <Reading result={result} waiting={waiting} handlers={handlers} />
            </Swap>
          ) : null}
        </Presence>

        {!result ? (
          <View style={{ marginTop: 12 }}>
            <PillButton
              label={busy ? 'Reading…' : 'Read my note'}
              variant="lime"
              onPress={() => void read()}
              disabled={busy || !!whyOff}
              whyDisabled={busy ? 'Reading what you said.' : whyOff}
            />
            {whyOff ? (
              <Text style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted, marginTop: 6 }}>{whyOff}</Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {result ? (
        <Swap id={'next:' + readNote}>
          <NextSteps result={result} picked={picked} setPicked={setPicked} handlers={handlers} />
        </Swap>
      ) : null}

      <Presence show={stale}>
        <Text style={{ fontSize: 12, lineHeight: 17, marginTop: 10, paddingHorizontal: 4, color: C.warnInk }}>
          The note has changed. Read it again to add what you wrote.
        </Text>
      </Presence>
      <Presence show={!!error}>
        {error ? (
          <Text style={{ fontSize: 12, lineHeight: 17, marginTop: 10, paddingHorizontal: 4, color: C.warnInk }}>{error}</Text>
        ) : null}
      </Presence>

      {/* Read again and Fill the visit, side by side once there is a reading.
          A stale reading offers only the reading again — filling the visit from
          an older note would put back what he has since corrected. */}
      {result ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <Pressable
            onPress={() => void read()}
            disabled={busy || !!whyOff}
            accessibilityRole="button"
            accessibilityLabel={busy ? 'Reading…' : 'Read it again'}
            accessibilityHint={busy ? 'Reading what you said.' : whyOff}
            accessibilityState={{ disabled: busy || !!whyOff, busy }}
            style={({ pressed }) => ({
              width: stale ? undefined : 60,
              flex: stale ? 1 : undefined,
              height: 60,
              borderRadius: 30,
              backgroundColor: C.surface,
              flexDirection: 'row',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 20px -10px rgba(15,27,51,0.35)',
              opacity: busy || whyOff ? 0.6 : pressed ? 0.85 : 1,
            })}>
            <Icon name="refresh" size={20} color={C.ink} strokeWidth={2} />
            {stale ? (
              <Text style={[{ fontSize: 16, color: C.ink }, weight(700)]}>{busy ? 'Reading…' : 'Read it again'}</Text>
            ) : null}
          </Pressable>
          {!stale ? (
            <PillButton
              label="Fill the visit"
              icon="tick"
              variant="navy"
              height={60}
              onPress={() => handlers.onFill(result)}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** What the reading made of the visit: the summary and its two tiles. */
function Reading({
  result,
  waiting,
  handlers,
}: {
  result: VisitAnalysis;
  waiting: number;
  handlers: VisitAssistantHandlers;
}) {
  return (
    <View style={{ marginTop: 10 }}>
      {result.summary ? <Text style={{ fontSize: 15, lineHeight: 21, color: '#FFFFFF' }}>{result.summary}</Text> : null}
      <Text style={{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted, marginTop: 6 }}>
        {waiting === 0 ? 'Nothing to answer. Check it and fill the visit.' : `${waiting} thing${waiting === 1 ? '' : 's'} to answer below.`}
      </Text>
      {result.notes.map((n) => (
        <Text key={n} style={{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted, marginTop: 4 }}>
          {n}
        </Text>
      ))}

      {result.outcome || result.comeBack ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          {/* ---- the outcome ---- */}
          {result.outcome ? (
            <Tile title="Save it as">
              {result.outcome.state === 'ready' ? (
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <Icon name={OUTCOME_ICON[result.outcome.key] ?? 'visit'} size={18} color={C.lime} strokeWidth={2} />
                    <Text style={[{ fontSize: 17, color: '#FFFFFF', flex: 1 }, weight(800)]}>{result.outcome.label}</Text>
                  </View>
                  <View style={{ marginTop: 6 }}>
                    <StatePill state="ready" />
                  </View>
                </View>
              ) : (
                <View>
                  <Text style={[{ fontSize: 13, color: '#FFC24A', marginTop: 6 }, weight(700)]}>Which was it?</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {result.outcomeChoices.map((o) => (
                      <Chip key={o.key} label={o.label} selected={false} onNavy onPress={() => handlers.onChooseOutcome(o.key)} />
                    ))}
                  </View>
                </View>
              )}
              <Text style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted, marginTop: 6 }}>{result.outcome.why}</Text>
            </Tile>
          ) : null}

          {/* ---- come back ---- */}
          {result.comeBack ? (
            <Tile title="Come back on" icon="cal">
              {result.comeBack.date ? (
                <View style={{ marginTop: 6, height: 32, paddingHorizontal: 10, borderRadius: 16, backgroundColor: C.surface, justifyContent: 'center', alignSelf: 'flex-start' }}>
                  <Text style={[{ fontSize: 13, color: C.ink }, weight(700)]}>{pretty(result.comeBack.date)}</Text>
                </View>
              ) : (
                <View style={{ gap: 6, marginTop: 6 }}>
                  {result.comeBack.choices.map((c) => (
                    <Chip key={c.date} label={c.label} selected={false} onNavy onPress={() => handlers.onChooseDate(c.date)} />
                  ))}
                </View>
              )}
              {result.comeBack.explanation ? (
                <Text style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted, marginTop: 6 }}>{result.comeBack.explanation}</Text>
              ) : null}
            </Tile>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Tile({ title, icon, children }: { title: string; icon?: IconName; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, minWidth: 0, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 18, padding: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {icon ? <Icon name={icon} size={13} color={C.onNavyMuted} strokeWidth={2} /> : null}
        <Text style={[{ fontSize: 12, color: C.onNavyMuted }, weight(700)]}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

/** What the reading proposes doing next, as white cards under the navy one. */
function NextSteps({
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
  const anything = result.actions.length || result.questions.length || result.competitor || result.feedback.length;
  if (!anything) return null;
  return (
    <View>
      {/* ---- what comes next ---- */}
      {result.actions.length ? (
        <>
          <Text style={[type.label, { color: C.ink, marginTop: 16, marginBottom: 8, marginHorizontal: 4 }]}>What comes next</Text>
          <View style={{ gap: 10 }}>
            {result.actions.map((a, i) => (
              <Stagger key={a.kind + i} index={i}>
                <ActionRow action={a} picked={picked} setPicked={setPicked} handlers={handlers} />
              </Stagger>
            ))}
          </View>
        </>
      ) : null}

      {result.questions.length ? (
        <View style={{ paddingHorizontal: 4, marginTop: 6 }}>
          <Questions items={result.questions} />
        </View>
      ) : null}

      {result.competitor || result.feedback.length ? (
        <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingVertical: 14, paddingHorizontal: 16, marginTop: 10 }}>
          <Text style={[{ fontSize: 13, color: C.ink }, weight(700)]}>For your manager</Text>
          {result.competitor ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Icon name="shop" size={16} color={C.muted} strokeWidth={2} />
              <Text style={{ fontSize: 14, color: C.ink, flex: 1 }}>
                {'Other brand: '}
                <Text style={weight(700)}>{result.competitor}</Text>
              </Text>
            </View>
          ) : null}
          {result.feedback.map((f) => (
            <Text
              key={f.text}
              style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: f.tone === 'negative' ? C.danger : f.tone === 'positive' ? C.success : C.ink }}>
              {(f.tone === 'negative' ? '▾ ' : f.tone === 'positive' ? '▴ ' : '• ') + f.text}
            </Text>
          ))}
          <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 6 }}>
            If it matters, keep it in the note. The office reads the note.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The button that opens a follow-on's own form, filled. The order is the one
 * the visit was most likely about, so it is the filled purple; the rest are
 * the tinted ones, and a lead decision is coloured by which way it goes.
 */
function DoorButton({
  label,
  onPress,
  look = 'tint',
}: {
  label: string;
  onPress: () => void;
  look?: 'primary' | 'tint' | 'good' | 'bad';
}) {
  const bg = look === 'primary' ? C.primary : look === 'good' ? C.successBg : look === 'bad' ? C.dangerBg : C.lavender;
  const fg = look === 'primary' ? '#FFFFFF' : look === 'good' ? C.success : look === 'bad' ? C.danger : C.primaryDeep;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      outerStyle={{ marginTop: 8 }}
      style={{
        minHeight: 48,
        borderRadius: 24,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 14,
      }}>
      <Text style={[{ fontSize: 14, color: fg, textAlign: 'center' }, weight(700)]}>{label}</Text>
    </PressableScale>
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
  const dup = a.state === 'duplicate';
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingVertical: 14, paddingHorizontal: 16, opacity: dup ? 0.85 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name={ACTION_ICON[a.kind] ?? 'spark'} size={20} color={C.primaryDeep} strokeWidth={2} />
        <Text style={[{ fontSize: 16, color: C.ink, flex: 1, minWidth: 0 }, weight(800)]}>{a.title}</Text>
        <StatePill state={a.state} />
      </View>
      <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 2 }}>{a.why}</Text>

      {a.kind === 'order'
        ? a.lines.map((l, i) => (
            <View key={l.said + i} style={{ marginTop: i ? 4 : 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ fontSize: 14, color: C.ink, flex: 1, minWidth: 0 }}>
                  {l.product.state === 'matched' ? l.product.name : `"${l.said}"`}
                </Text>
                <Text style={[{ fontSize: 14, color: l.quantityCans != null ? C.ink : C.warnInk }, weight(700)]}>
                  {l.quantityCans != null ? `× ${l.quantityCans}` : l.saidAs ? `said ${l.saidAs}` : 'quantity?'}
                </Text>
              </View>
              {l.product.state === 'ambiguous' ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {l.product.options.map((o) => (
                    <Chip
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
        <Text style={[{ fontSize: 14, color: C.ink, marginTop: 6 }, weight(600)]}>{'Pays on ' + pretty(a.date.date)}</Text>
      ) : null}
      {a.kind === 'requirement' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {[a.what, a.monthlyLitres != null ? `${a.monthlyLitres} L / month` : null, a.cans != null ? `${a.cans} cans` : null]
            .filter((x): x is string => !!x)
            .map((t) => (
              <View key={t} style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.wash, justifyContent: 'center' }}>
                <Text style={[{ fontSize: 13, color: C.ink }, weight(700)]}>{t}</Text>
              </View>
            ))}
        </View>
      ) : null}

      <Questions items={dup ? [] : a.questions} />

      {dup ? null : a.kind === 'order' ? (
        <DoorButton label="Add to cart, open order" look="primary" onPress={() => handlers.onOrder(a, picked)} />
      ) : a.kind === 'payment' ? (
        <DoorButton label="Open filled receipt" onPress={() => handlers.onPayment(a)} />
      ) : a.kind === 'complaint' ? (
        <DoorButton label="Open filled complaint" onPress={() => handlers.onComplaint(a)} />
      ) : a.kind === 'sample' ? (
        <DoorButton label="Open filled sample request" onPress={() => handlers.onSample(a)} />
      ) : a.kind === 'requirement' ? (
        <DoorButton label="Fill what they need" onPress={() => handlers.onRequirement(a)} />
      ) : a.kind === 'lead_decision' && a.decision ? (
        <DoorButton
          label={a.decision === 'qualified' ? 'Mark it "A prospect"' : 'Mark it "Lost"'}
          look={a.decision === 'qualified' ? 'good' : 'bad'}
          onPress={() => handlers.onDecision(a.decision as 'qualified' | 'lost')}
        />
      ) : null}
    </View>
  );
}
