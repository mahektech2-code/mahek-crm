import React from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { VoiceField } from '../src/components/ui/dictate';
import { color as C, radius, weight } from '../src/theme/tokens';
import { recordValidation, validationRefusal, validationScript, type ValidationScript } from '../src/data/validations';
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
  const [product, setProduct] = React.useState('');
  const [quality, setQuality] = React.useState('');
  const [dispatch, setDispatch] = React.useState('');
  const [behaviour, setBehaviour] = React.useState('');
  const [requirement, setRequirement] = React.useState('');
  const [litres, setLitres] = React.useState('');
  const [competitor, setCompetitor] = React.useState('');
  const [verdict, setVerdict] = React.useState<'pending' | 'confirmed' | 'not_qualified' | 'on_hold'>('pending');
  const [why, setWhy] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

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
    Boolean(
      (product + quality + dispatch + behaviour + requirement + litres + competitor + why).trim(),
    );

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
    if (saving) return;
    /* Refused BEFORE the write and in the same words the service uses, so the
       sentence he had in mind while the customer's words were fresh is not
       lost to a round trip that comes back with a refusal. */
    const refusal = validationRefusal({ customerId: id, reached, verdict, verdictReason: why.trim() || null });
    if (refusal) return setErr(refusal);
    setSaving(true);
    const result = await recordValidation({
      customerId: id,
      reached,
      productFeedback: product.trim() || null,
      qualityFeedback: quality.trim() || null,
      dispatchFeedback: dispatch.trim() || null,
      salesmanFeedback: behaviour.trim() || null,
      confirmedRequirement: requirement.trim() || null,
      confirmedMonthlyVolumeLitres: Number(litres.replace(/[^\d]/g, '')) || null,
      confirmedCompetitor: competitor.trim() || null,
      verdict,
      verdictReason: why.trim() || null,
      taskId: params.taskId ?? null,
    });
    if (!result.ok) {
      setErr(result.message ?? 'That could not be saved.');
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
            <SectionLabel>What they said about the visit</SectionLabel>
            <T s="caption" style={{ marginTop: 4 }}>
              All optional. Write down what they actually said, not a summary.
            </T>
            {[
              { label: 'The products, explained clearly?', v: product, set: setProduct },
              { label: 'The quality', v: quality, set: setQuality },
              { label: 'Dispatch and service', v: dispatch, set: setDispatch },
              { label: 'How our man was with them', v: behaviour, set: setBehaviour },
            ].map((f) => (
              <View key={f.label} style={{ marginTop: 12 }}>
                <SectionLabel style={{ marginBottom: 6 }}>{f.label}</SectionLabel>
                {/* "What they actually said, not a summary" asked of a single
                    line that scrolls sideways. Prose, so it gets the mic. */}
                <VoiceField value={f.v} onChangeText={f.set} placeholder="In their words" />
              </View>
            ))}
          </Card>

          <Card style={{ marginTop: 12 }}>
            <SectionLabel>What they say they need</SectionLabel>
            {/* Kept apart from the lead's own columns on purpose: what the
                salesman was told and what the office was told are two readings
                of one shop, and the difference is the point of this call. */}
            <T s="caption" style={{ marginTop: 4 }}>
              Recorded beside what the salesman reported, never over it.
            </T>
            <View style={{ marginTop: 12 }}>
              <SectionLabel style={{ marginBottom: 6 }}>Requirement</SectionLabel>
              <Input value={requirement} onChangeText={setRequirement} placeholder="Thinner for a spray booth" />
            </View>
            <View style={{ marginTop: 12 }}>
              <SectionLabel style={{ marginBottom: 6 }}>Monthly volume</SectionLabel>
              <Input value={litres} onChangeText={setLitres} placeholder="200" keyboardType="number-pad" />
              <T s="caption" style={{ marginTop: 6 }}>In litres, as they say it.</T>
            </View>
            <View style={{ marginTop: 12 }}>
              <SectionLabel style={{ marginBottom: 6 }}>Buying from</SectionLabel>
              <Input value={competitor} onChangeText={setCompetitor} placeholder="Asian Paints" />
            </View>
          </Card>
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
