import React from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { color as C, radius, weight } from '../src/theme/tokens';
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
import { useStore } from '../src/state/store';

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
      title: 'Leave without recording the call?',
      body: 'Nothing you have written down here is saved yet, and none of it is kept.',
      confirmLabel: 'Discard it',
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
    if (refusal) return setErr(refusal);
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
      confirmedMonthlyVolumeLitres: Number(litres.replace(/[^\d]/g, '')) || null,
      verdict,
      verdictReason: why.trim() || null,
      taskId: params.taskId ?? null,
    });
    if (!result.ok) {
      setErr(result.message ?? 'That could not be saved.');
      inFlight.current = false;
      setSaving(false);
      return;
    }
    notify('Validation call recorded · ' + (lead?.company?.trim() || lead?.name || 'lead'));
    router.back();
  };

  return (
    <AppFrame
      title="Validation call"
      activeTab={null}
      onBack={leave}
      contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={leave} />

      <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink, marginTop: 4 }, weight(600)]}>
        {lead?.company?.trim() || lead?.name || 'Lead'}
      </T>
      {lead?.city ? <T s="caption" style={{ marginTop: 2 }}>{lead.city}</T> : null}

      {/* THE NUMBER IS THE POINT OF THIS SCREEN, so it is a row with a button
          rather than half of a joined caption. It sat inside a plain, unselectable
          string beside a script telling him what to say — so the one screen whose
          entire purpose is a phone call was the one screen he had to retype a
          ten-digit number out of. Three others in this app taught him a number
          is tappable. */}
      {lead?.mobile ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <T style={[{ flex: 1, minWidth: 0, fontSize: 16, color: C.ink }, weight(500)]} selectable>
            {lead.mobile}
          </T>
          <SecondaryButton
            label="Call"
            fullWidth={false}
            onPress={() => {
              void callNumber(lead.mobile ?? '').then((out) => {
                if (out.status === 'failed') notify(out.reason);
              });
            }}
          />
        </View>
      ) : null}

      {/* ---- the script, straight from configuration ---- */}
      {script.map((section) => (
        <Card key={section.heading} style={{ marginTop: 12 }}>
          <T style={[{ fontSize: 14, color: C.ink }, weight(600)]}>{section.heading}</T>
          {section.lines.map((line, i) => (
            <T key={i} style={{ fontSize: 15, lineHeight: 22, marginTop: 6, color: C.body }}>
              {line}
            </T>
          ))}
        </Card>
      ))}

      {/* A handset that has not finished a bootstrap has no script row and no
          default behind one, so this section simply was not drawn — the screen
          went from the shop's name to "Did you get through?" and he made the
          call with no idea that questions he was meant to read out existed. */}
      {script.length === 0 ? (
        <Card style={{ marginTop: 12 }}>
          <T style={[{ fontSize: 14, color: C.ink }, weight(600)]}>The script has not reached this phone yet</T>
          <T s="caption" style={{ marginTop: 4 }}>
            It arrives with the next sync. Make the call from what you know and record the answers below.
          </T>
        </Card>
      ) : null}

      <Card style={{ marginTop: 12 }}>
        <SectionLabel>Did you get through?</SectionLabel>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Choice label="Yes" selected={reached} onPress={() => setReached(true)} style={{ paddingHorizontal: 18 }} />
          {/* A call nobody answered is still a call that was made. Recording
              only the successful ones makes the follow-up look effortless. */}
          <Choice label="No answer" selected={!reached} onPress={() => setReached(false)} style={{ paddingHorizontal: 18 }} />
        </View>
      </Card>

      {reached ? (
        <>
          <Card style={{ marginTop: 12 }}>
            <SectionLabel>What they said</SectionLabel>
            <T s="caption" style={{ marginTop: 4 }}>
              Nothing here is required. Write down what they actually said, not a summary.
            </T>
            {/* THE BLANK AND THE "NO" ARE DIFFERENT FACTS, and the column
                cannot tell them apart unless the caller does. An empty box
                says nobody asked; "no problem with the price" says it was
                asked and answered, which is what somebody deciding what to
                offer next is reading for. The office's own form says
                this above its grid and the phone has to say it too — the two
                doors are one table, and a rule stated at one of them is a rule
                half the answers were never written under. */}
            <T s="caption" style={{ marginTop: 6 }}>
              If the answer was no, write that down rather than leaving the box empty. A blank
              says nobody asked, which is a different thing.
            </T>
          </Card>

          {SECTIONS.map((section) => (
            <Card key={section.id} style={{ marginTop: 12 }}>
              <T style={[{ fontSize: 14, color: C.ink }, weight(600)]}>{section.title}</T>
              <T s="caption" style={{ marginTop: 4 }}>{section.says}</T>
              {section.questions.map((q) => (
                <View key={q.id} style={{ marginTop: 12 }}>
                  <SectionLabel style={{ marginBottom: 6 }}>{q.ask}</SectionLabel>
                  {/* "What they actually said, not a summary" asked of a single
                      line that scrolls sideways. Prose, so it gets the mic. */}
                  <VoiceField
                    value={answers[q.id] ?? ''}
                    onChangeText={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                    placeholder="In their words"
                  />
                </View>
              ))}

              {/* The NUMBER, beside the sentence that carries it and never
                  parsed out of it. "About 15-20 tins, more in season" is the
                  answer above; a figure guessed from it would be a confident
                  wrong number on the owner's own screens, which is where a
                  wrong number does the most damage. Asked here rather than in
                  a card of its own because it is the same question. */}
              {section.id === 'opportunity' ? (
                <View style={{ marginTop: 12 }}>
                  <SectionLabel style={{ marginBottom: 6 }}>Monthly volume</SectionLabel>
                  <Input value={litres} onChangeText={setLitres} placeholder="200" keyboardType="number-pad" />
                  <T s="caption" style={{ marginTop: 6 }}>
                    In litres, only if they gave a figure. Recorded beside what the salesman
                    reported, never over it.
                  </T>
                </View>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}

      <Card style={{ marginTop: 12 }}>
        <SectionLabel>Your call</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {VERDICTS.map((o) => (
            <Choice
              key={o.v}
              label={o.label}
              selected={verdict === o.v}
              onPress={() => {
                setVerdict(o.v);
                setErr(null);
              }}
              style={{ paddingHorizontal: 14 }}
            />
          ))}
        </View>

        {verdict === 'not_qualified' || verdict === 'on_hold' ? (
          <View style={{ marginTop: 12 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Why</SectionLabel>
            <Input
              value={why}
              onChangeText={(v) => {
                setWhy(v);
                setErr(null);
              }}
              placeholder={verdict === 'on_hold' ? 'What we are waiting for' : 'What was wrong'}
            />
          </View>
        ) : null}

        {verdict === 'confirmed' ? (
          <T s="caption" style={{ marginTop: 10 }}>
            A requirement visit lands on the salesman&apos;s list when you save this.
          </T>
        ) : null}

        {err ? (
          <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
            <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
          </View>
        ) : null}
      </Card>

      <Divider style={{ marginTop: 20 }} />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <SecondaryButton label="Cancel" onPress={back.go} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label={saving ? 'Saving…' : 'Record the call'}
          onPress={save}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </AppFrame>
  );
}
