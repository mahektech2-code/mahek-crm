import React from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Choice, Divider, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { color as C, radius, weight } from '../src/theme/tokens';
import { recordValidation, validationScript, type ValidationScript } from '../src/data/validations';
import { getLead, type Lead } from '../src/data/leads';
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

  const save = async () => {
    if (saving) return;
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
      onBack={back.go}
      contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink, marginTop: 4 }, weight(600)]}>
        {lead?.company?.trim() || lead?.name || 'Lead'}
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        {[lead?.city, lead?.mobile].filter(Boolean).join(' · ')}
      </T>

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
                <Input value={f.v} onChangeText={f.set} placeholder="In their words" />
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
