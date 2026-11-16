import React from 'react';
import { Animated, Pressable, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { PillButton } from '../src/components/ui/v3';
import { Icon, type IconName } from '../src/components/ui/Icon';
import { LeadGlyph } from '../src/components/leads/v3-parts';
import { PrimaryButton } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { color as C, weight } from '../src/theme/tokens';
import {
  answerableQuestions,
  carriedColumnFor,
  recordValidation,
  validationRefusal,
  validationScript,
  type CarriedColumn,
  type ValidationScript,
} from '../src/data/validations';
import { VERIFICATION_SECTIONS } from '../src/engines/funnel/lead-labels';
import { getLead, type Lead } from '../src/data/leads';
import { callNumber } from '../src/lib/messaging';
import { cleanDecimal, parseDecimal } from '../src/lib/decimal-input';
import { useStore } from '../src/state/store';
import { Presence, useShake } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';

/**
 * §E — the Prospect validation call.
 *
 * The office rings the shop the working day after a lead is qualified and asks
 * what the salesman's visit was actually like. Everything on this screen is
 * optional except one thing: turning a Prospect down has to say why, because
 * the salesman who raised it will raise the next one exactly like it otherwise.
 *
 * The script is read from configuration rather than written into this file. It
 * is CONTENT — it will be argued about, improved after a bad call and
 * eventually translated — and none of that should need a new APK on a phone
 * nobody can recall.
 */

/**
 * §8's OWN QUESTIONS, in §8's own words, under §8's own headings.
 *
 * This screen asked four questions of its own — "The products, explained
 * clearly?", "The quality", "Dispatch and service", "How our man was with
 * them" — typed into the file. They are §E's four and they are not the list
 * the office's verification form asks, so the phone and the desk were two
 * doors writing one table with different questions on them: a call made from a
 * car recorded a different conversation to the same call made at a desk, and
 * no report reading that table could tell which.
 *
 * The list is `VERIFICATION_SECTIONS` and `answerableQuestions`, mirrored from
 * MahekOne's own `lead-labels.ts`. A question reworded there is reworded here
 * without an APK, and a question ADDED there appears here the day its answer
 * has somewhere to land — which is what `answerableQuestions` is filtering on,
 * and why a section with nothing landable is not drawn at all. A heading
 * promising "what they are ready for" over an empty card is a worse answer
 * than a heading that is absent.
 */
const SECTIONS = VERIFICATION_SECTIONS.map((s) => ({
  ...s,
  questions: answerableQuestions(s.id),
})).filter((s) => s.questions.length > 0);

const VERDICTS = [
  { v: 'confirmed' as const, label: 'A real Prospect' },
  { v: 'on_hold' as const, label: 'On hold' },
  { v: 'not_qualified' as const, label: 'Not qualified' },
  { v: 'pending' as const, label: 'Decide later' },
];

export default function ValidateLead() {
  const params = useLocalSearchParams<{ id?: string; taskId?: string }>();
  const id = params.id ?? '';
  const back = useCameFrom('tasks');
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);

  const [lead, setLead] = React.useState<Lead | null>(null);
  const [script, setScript] = React.useState<ValidationScript>([]);
  const [reached, setReached] = React.useState(true);
  /* Keyed on the QUESTION rather than a field per column, so a question added
     to the shared list needs nothing here. */
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [litres, setLitres] = React.useState('');
  const [verdict, setVerdict] = React.useState<'pending' | 'confirmed' | 'not_qualified' | 'on_hold'>('pending');
  const [why, setWhy] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const inFlight = React.useRef(false);
  /* The box under the verdict shakes when it speaks, and the buzz says which
     kind of no: `warning` for a call refused before it was written (something
     is missing he can supply), `error` for a write that failed. */
  const errShake = useShake(null);
  const refuse = (message: string, kind: 'warning' | 'error') => {
    setErr(message);
    feedback(kind);
    errShake.shake();
  };

  React.useEffect(() => {
    if (!id) return;
    let live = true;
    void Promise.all([getLead(id), validationScript()]).then(([l, s]) => {
      if (!live) return;
      setLead(l);
      setScript(s);
    });
    return () => {
      live = false;
    };
  }, [id]);

  /* Ten minutes of a phone call, held in component state and nowhere else. All
     three ways off this screen are a `router.replace`, which destroys the
     route — so a mis-tap on the 48dp chevron at the top of a tall phone lost
     the whole call and it had to be made again. */
  const dirty =
    !reached ||
    verdict !== 'pending' ||
    Boolean((Object.values(answers).join('') + litres + why).trim());

  const leave = () => {
    if (!dirty) return back.go();
    askConfirm({
      title: 'Leave without saving the call?',
      body: 'What you wrote here is not saved. It will be lost.',
      confirmLabel: 'Delete it',
      run: () => back.go(),
    });
  };

  const save = async () => {
    /* A ref rather than the `saving` flag: state is a render behind, and two
       taps on a phone that has just gone quiet arrive inside one. */
    if (inFlight.current) return;
    /* Refused BEFORE the write and in the same words the service uses, so the
       sentence he had in mind while the customer's words were fresh is not
       lost to a round trip that comes back with a refusal. */
    const refusal = validationRefusal({ customerId: id, reached, verdict, verdictReason: why.trim() || null });
    if (refusal) return refuse(refusal, 'warning');
    inFlight.current = true;
    setSaving(true);

    /* Each answer into the column that question lands in, looked up rather
       than typed out beside it — one mapping, read here and by the office's
       own form, because a screen holding its own copy of which column is which
       is a screen that files the credit answer under quality the day somebody
       adds a question. */
    const carried: Partial<Record<CarriedColumn, string | null>> = {};
    for (const [questionId, said] of Object.entries(answers)) {
      const column = carriedColumnFor(questionId);
      if (column) carried[column] = said.trim() || null;
    }

    const result = await recordValidation({
      ...carried,
      customerId: id,
      reached,
      confirmedMonthlyVolumeLitres: parseDecimal(litres) || null,
      verdict,
      verdictReason: why.trim() || null,
      taskId: params.taskId ?? null,
    });
    if (!result.ok) {
      refuse(result.message ?? 'Could not save. Try again.', 'error');
      inFlight.current = false;
      setSaving(false);
      return;
    }
    notify('Check call saved · ' + (lead?.company?.trim() || lead?.name || 'lead'));
    router.back();
  };

  const shop = lead?.company?.trim() || lead?.name || 'Lead';
  const hero = (
    <View style={{ marginTop: 16 }}>
      <Text style={[{ fontSize: 13, color: C.lime }, weight(700)]}>Check call</Text>
      <Text accessibilityRole="header" style={[{ fontSize: 24, lineHeight: 30, letterSpacing: -0.4, color: '#FFFFFF', marginTop: 4 }, weight(800)]}>
        {shop}
      </Text>
      {/* THE NUMBER IS THE POINT OF THIS SCREEN, so it is a row with a button
          rather than half of a joined caption. The one screen whose entire
          purpose is a phone call must not be the one screen he has to retype a
          ten-digit number out of. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <Text style={[{ flex: 1, minWidth: 0, fontSize: 13, color: C.onNavyMuted }, weight(400)]}>
          {lead?.city ? lead.city + (lead?.mobile ? ' · ' : '') : ''}
          {lead?.mobile ? (
            <Text selectable style={[{ fontSize: 15, color: '#FFFFFF' }, weight(600)]}>
              {lead.mobile}
            </Text>
          ) : null}
        </Text>
        {lead?.mobile ? (
          <PillButton
            label="Call"
            a11y={'Call ' + shop}
            icon="call"
            variant="lime"
            height={48}
            onPress={() => {
              void callNumber(lead.mobile ?? '').then((out) => {
                if (out.status === 'failed') notify(out.reason, 'error');
              });
            }}
          />
        ) : null}
      </View>
    </View>
  );

  return (
    <AppFrame
      title="Check call"
      tone="navy"
      showTitle={false}
      hero={hero}
      activeTab={null}
      onBack={leave}
      contentStyle={{ padding: 14, paddingBottom: 32, gap: 10 }}>
      {/* ---- the script, straight from configuration ---- */}
      {script.map((section, si) => (
        <CallCard key={section.heading}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name={si === 0 ? 'chat' : 'note'} size={16} color={C.primaryDeep} strokeWidth={2} />
            <Text accessibilityRole="header" style={[{ fontSize: 13, color: C.primaryDeep }, weight(700)]}>{section.heading}</Text>
          </View>
          {section.lines.map((line, i) => (
            <Text key={i} style={[{ fontSize: 14, lineHeight: 20, marginTop: i ? 4 : 6, color: C.ink }, weight(400)]}>
              {line}
            </Text>
          ))}
        </CallCard>
      ))}

      {/* A handset that has not finished a bootstrap has no script row and no
          default behind one — say so, so he knows questions he was meant to
          read out exist. */}
      {script.length === 0 ? (
        <CallCard>
          <Text style={[{ fontSize: 14, color: C.ink }, weight(700)]}>The call script is not on this phone yet</Text>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 4 }, weight(400)]}>
            It will come next time the app sends to office. Make the call anyway. Write the answers below.
          </Text>
        </CallCard>
      ) : null}

      <CallCard row>
        <Text style={[{ flex: 1, fontSize: 15, color: C.ink }, weight(700)]}>Got through?</Text>
        <CallChip label="Yes" a11y="Did you get through? Yes" on={reached} onPress={() => setReached(true)} />
        {/* A call nobody answered is still a call that was made. Recording
            only the successful ones makes the follow-up look effortless. */}
        <CallChip label="No answer" a11y="Did you get through? No answer" on={!reached} onPress={() => setReached(false)} />
      </CallCard>

      {/* The questions go and come back with "No answer" — in place, so
          the verdict below slides up to meet his thumb rather than jumping. */}
      <Presence show={reached}>
        <View style={{ gap: 10 }}>
          {/* THE BLANK AND THE "NO" ARE DIFFERENT FACTS, and the column cannot
              tell them apart unless the caller does. An empty box says nobody
              asked; "no problem with the price" says it was asked and
              answered. The office's own form says this above its grid and the
              phone has to say it too — the two doors are one table. */}
          <View
            accessible
            accessibilityLabel="What they said. Nothing here is a must. Write what they said, in their words. If the answer was no, write no. Do not leave the box empty. An empty box means nobody asked."
            style={{ backgroundColor: C.primaryTint, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12 }}>
            <Text style={[{ fontSize: 12, lineHeight: 17, color: C.primaryDeep }, weight(600)]}>
              In their words · nothing is a must · if no, write no — empty means nobody asked
            </Text>
          </View>

          {SECTIONS.map((section) => (
            <CallCard key={section.id}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon
                  name={SECTION_ICON[section.id] ?? 'note'}
                  size={18}
                  color={section.id === 'objections' ? C.danger : section.id === 'readiness' ? C.primaryDeep : C.ink}
                  strokeWidth={2}
                />
                <Text accessibilityRole="header" style={[{ flex: 1, fontSize: 15, color: C.ink }, weight(800)]}>{section.title}</Text>
              </View>
              <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 4 }, weight(400)]}>{section.says}</Text>
              {section.questions.map((q) => (
                <View key={q.id} style={{ marginTop: 10 }}>
                  <Text style={[{ fontSize: 12, lineHeight: 17, color: C.ink, marginBottom: 6 }, weight(700)]}>{q.ask}</Text>
                  {/* "What they actually said, not a summary" — prose, so it
                      gets the mic. */}
                  <VoiceField
                    value={answers[q.id] ?? ''}
                    onChangeText={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                    placeholder="In their words"
                    style={{ borderRadius: 16, backgroundColor: C.canvas, borderWidth: 0, minHeight: 48 }}
                  />
                </View>
              ))}

              {/* The NUMBER, beside the sentence that carries it and never
                  parsed out of it. A figure guessed from "about 15-20 tins,
                  more in season" would be a confident wrong number on the
                  owner's own screens. */}
              {section.id === 'opportunity' ? (
                <View style={{ marginTop: 10 }}>
                  <View style={{ minHeight: 52, borderRadius: 16, backgroundColor: C.canvas, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 }}>
                    <LeadGlyph name="drop" size={18} color={C.muted} strokeWidth={2} />
                    <TextInput
                      value={litres}
                      onChangeText={(v) => setLitres(cleanDecimal(v, 2))}
                      placeholder="200"
                      placeholderTextColor={C.faint}
                      keyboardType="decimal-pad"
                      accessibilityLabel="Monthly volume, in litres"
                      style={[{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink, paddingVertical: 12 }, weight(400)]}
                    />
                    <Text style={[{ fontSize: 12, color: C.faint }, weight(400)]}>L/mo</Text>
                  </View>
                  <Text style={[{ fontSize: 11, lineHeight: 15, color: C.faint, marginTop: 4 }, weight(400)]}>
                    Only if they said a number · saved beside the salesman&apos;s, never replaces it
                  </Text>
                </View>
              ) : null}
            </CallCard>
          ))}
        </View>
      </Presence>

      <CallCard>
        <Text accessibilityRole="header" style={[{ fontSize: 15, color: C.ink }, weight(800)]}>Your call</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {VERDICTS.map((o) => {
            const on = verdict === o.v;
            const tint =
              o.v === 'confirmed'
                ? { bg: C.successBg, fg: C.success }
                : o.v === 'not_qualified'
                  ? { bg: C.dangerBg, fg: C.danger }
                  : { bg: C.canvas, fg: C.ink };
            return (
              <Pressable
                key={o.v}
                onPress={() => {
                  if (!on) feedback('select');
                  setVerdict(o.v);
                  setErr(null);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={o.label}
                hitSlop={{ top: 4, bottom: 4 }}
                style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 22, justifyContent: 'center', backgroundColor: on ? C.navy : tint.bg }}>
                <Text style={[{ fontSize: 13, color: on ? '#FFFFFF' : tint.fg }, weight(700)]}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Presence show={verdict === 'not_qualified' || verdict === 'on_hold'}>
          <TextInput
            value={why}
            onChangeText={(v) => {
              setWhy(v);
              setErr(null);
            }}
            placeholder={verdict === 'on_hold' ? 'Why · what we are waiting for' : 'Why · what was wrong'}
            placeholderTextColor={C.faint}
            accessibilityLabel="Why"
            style={[{ marginTop: 10, minHeight: 52, borderRadius: 16, backgroundColor: C.canvas, paddingHorizontal: 14, fontSize: 14, color: C.ink }, weight(400)]}
          />
        </Presence>

        <Presence show={verdict === 'confirmed'}>
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 10 }, weight(400)]}>
            When you save, a visit to find their need goes on the salesman&apos;s list.
          </Text>
        </Presence>

        <Presence show={!!err}>
          <Animated.View
            style={[{ marginTop: 8, minHeight: 36, backgroundColor: C.dangerBg, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center' }, errShake.style]}>
            <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(600)]}>{err}</Text>
          </Animated.View>
        </Presence>
      </CallCard>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        <Pressable
          onPress={leave}
          accessibilityRole="button"
          style={({ pressed }) => ({ width: 120, height: 60, borderRadius: 30, backgroundColor: pressed ? C.wash : C.surface, alignItems: 'center', justifyContent: 'center' })}>
          <Text style={[{ fontSize: 15, color: C.ink }, weight(700)]}>Cancel</Text>
        </Pressable>
        <PrimaryButton
          label={saving ? 'Saving…' : 'Save call'}
          tone="navy"
          onPress={save}
          style={{ flex: 1, height: 60, minHeight: 60, borderRadius: 30 }}
        />
      </View>
    </AppFrame>
  );
}

/** The icon beside each section of questions. */
const SECTION_ICON: Record<string, IconName> = {
  salesman: 'person',
  opportunity: 'shop',
  objections: 'warn',
  readiness: 'sample',
};

/** A white V3 card on the call screen. */
function CallCard({ children, row = false }: { children: React.ReactNode; row?: boolean }) {
  return (
    <View
      style={[
        { backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14 },
        row ? { flexDirection: 'row', alignItems: 'center', gap: 8 } : null,
      ]}>
      {children}
    </View>
  );
}

/** A 44 choice pill. */
function CallChip({ label, a11y, on, onPress }: { label: string; a11y: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        if (!on) feedback('select');
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={a11y}
      style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 22, justifyContent: 'center', backgroundColor: on ? C.navy : C.canvas }}>
      <Text style={[{ fontSize: 14, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>{label}</Text>
    </Pressable>
  );
}
