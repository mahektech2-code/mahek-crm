import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Divider, Input, PrimaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { color as C, radius, weight } from '../src/theme/tokens';
import { listSamples, updateSample, type Sample } from '../src/data/requests';
import { takePhoto } from '../src/native/capture';
import { dmy } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * One sample, from the lorry to the verdict — §I, §J and §K.
 *
 * The screen is built around the one distinction the table exists to keep: WE
 * SENT IT, the carrier says it arrived, and the SHOP says it is in their hands
 * are three different claims by three different parties. Only the third starts
 * the review clock, because a review call timed from the day we posted it rings
 * a customer still waiting for the parcel.
 */

const SATISFACTION = ['Not happy', 'Alright', 'Pleased', 'Very pleased'];

export default function SampleRecord() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';
  const back = useCameFrom('samples');
  const notify = useStore((s) => s.notify);

  const [row, setRow] = React.useState<Sample | null>(null);
  const [courier, setCourier] = React.useState('');
  const [tracking, setTracking] = React.useState('');
  const [satisfaction, setSatisfaction] = React.useState<string | null>(null);
  const [alsoWants, setAlsoWants] = React.useState('');
  const [why, setWhy] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    let live = true;
    void listSamples().then((all) => {
      if (!live) return;
      const found = all.find((s) => s.id === id) ?? null;
      setRow(found);
      setCourier(found?.courierName ?? '');
      setTracking(found?.trackingNumber ?? '');
      setSatisfaction(found?.satisfaction ?? null);
      setAlsoWants(found?.additionalRequirement ?? '');
    });
    return () => {
      live = false;
    };
  }, [id]);

  React.useEffect(load, [load]);

  const apply = async (p: Parameters<typeof updateSample>[1], said: string) => {
    const result = await updateSample(id, p);
    if (!result.ok) {
      setErr(result.message ?? 'That could not be saved.');
      return;
    }
    setErr(null);
    notify(said);
    load();
  };

  if (!row) {
    return (
      <AppFrame title="Sample" activeTab={null} onBack={back.go} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={back.go} />
        <T s="caption" style={{ marginTop: 12 }}>Loading…</T>
      </AppFrame>
    );
  }

  return (
    <AppFrame title="Sample" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />

      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]}>
            {row.productName ?? 'Sample'}
          </T>
          <T s="caption" style={{ marginTop: 2 }}>Asked for {dmy(new Date(row.requestedAt).toISOString().slice(0, 10))}</T>
        </View>
        <Badge tone={row.trialOutcome === 'approved' ? 'success' : row.trialOutcome === 'rejected' ? 'danger' : 'info'}>
          {row.state}
        </Badge>
      </View>

      {/* ---- §I · on its way ---- */}
      <Card style={{ marginTop: 12 }}>
        <SectionLabel>On its way</SectionLabel>
        <T s="caption" style={{ marginTop: 4 }}>
          {row.dispatchedAt ? 'Sent ' + dmy(new Date(row.dispatchedAt).toISOString().slice(0, 10)) : 'Not sent yet'}
        </T>

        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Courier or transport</SectionLabel>
          <Input value={courier} onChangeText={setCourier} placeholder="VRL Logistics" />
        </View>
        <View style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Tracking number</SectionLabel>
          <Input value={tracking} onChangeText={setTracking} placeholder="If there is one" />
        </View>

        <PrimaryButton
          label={row.dispatchedAt ? 'Update the dispatch' : 'Mark it sent'}
          onPress={() =>
            apply(
              {
                dispatchedAt: row.dispatchedAt ?? Date.now(),
                courierName: courier.trim() || null,
                trackingNumber: tracking.trim() || null,
              },
              'Dispatch recorded',
            )
          }
          style={{ marginTop: 14, borderRadius: radius.xl }}
        />
      </Card>

      {/* ---- §J · did it actually arrive ---- */}
      <Card style={{ marginTop: 12 }}>
        <SectionLabel>Did it reach them?</SectionLabel>
        {/* The distinction the whole table exists for. Delivered is our side
            saying it went; received is the shop saying it came. The second is
            never inferred from the first — that would assert something nobody
            asked the customer. */}
        <T s="caption" style={{ marginTop: 4 }}>
          {row.receivedAt
            ? 'They confirmed it on ' + dmy(new Date(row.receivedAt).toISOString().slice(0, 10))
            : row.deliveredAt
              ? 'Delivered, but they have not confirmed it yet. The follow-up stays open.'
              : 'Not delivered yet.'}
        </T>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
          <DashedButton
            label="Delivered"
            onPress={async () => {
              const shot = await takePhoto({ parentType: 'sample', parentId: id, kind: 'sample_proof' });
              await apply(
                {
                  deliveredAt: Date.now(),
                  deliveryPhotoId: shot.ok ? shot.mediaId : null,
                },
                'Delivery recorded',
              );
            }}
            style={{ flex: 1 }}
          />
          <PrimaryButton
            label="They have it"
            onPress={() => apply({ receivedAt: Date.now() }, 'Confirmed received — a review call is on its way')}
            style={{ flex: 1, borderRadius: radius.xl }}
          />
        </View>
      </Card>

      {/* ---- §K · the trial ---- */}
      {row.receivedAt ? (
        <Card style={{ marginTop: 12 }}>
          <SectionLabel>The trial</SectionLabel>
          <T s="caption" style={{ marginTop: 4 }}>
            {row.trialCompletedAt
              ? 'Finished'
              : row.trialStartedAt
                ? 'Started — not finished yet'
                : 'Not started'}
          </T>

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <DashedButton
              label={row.trialStartedAt ? 'Started ✓' : 'They started it'}
              onPress={() => apply({ trialStartedAt: Date.now() }, 'Trial started')}
              style={{ flex: 1 }}
            />
            <DashedButton
              label={row.trialCompletedAt ? 'Finished ✓' : 'They finished'}
              onPress={() => apply({ trialCompletedAt: Date.now() }, 'Trial finished')}
              style={{ flex: 1 }}
            />
          </View>

          <View style={{ marginTop: 14 }}>
            <SectionLabel style={{ marginBottom: 6 }}>How they found it</SectionLabel>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SATISFACTION.map((v) => (
                <Choice
                  key={v}
                  label={v}
                  selected={satisfaction === v}
                  onPress={() => setSatisfaction(satisfaction === v ? null : v)}
                  style={{ paddingHorizontal: 14 }}
                />
              ))}
            </View>
          </View>

          <View style={{ marginTop: 12 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Anything else they asked for</SectionLabel>
            <Input value={alsoWants} onChangeText={setAlsoWants} placeholder="While you had their attention" />
          </View>

          <Divider style={{ marginTop: 18 }} />
          <SectionLabel style={{ marginTop: 14, marginBottom: 6 }}>The verdict</SectionLabel>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <PrimaryButton
              label="Approved"
              onPress={() =>
                apply(
                  {
                    trialOutcome: 'approved',
                    satisfaction,
                    additionalRequirement: alsoWants.trim() || null,
                  },
                  'Approved — negotiation is open',
                )
              }
              style={{ flex: 1, borderRadius: radius.xl }}
            />
            <DashedButton
              label="Rejected"
              onPress={() =>
                apply(
                  {
                    trialOutcome: 'rejected',
                    satisfaction,
                    rejectionReason: why.trim() || null,
                    additionalRequirement: alsoWants.trim() || null,
                  },
                  'Recorded',
                )
              }
              style={{ flex: 1 }}
            />
          </View>

          {/* Asked before the button is pressed rather than after it is
              refused: a rejection with nothing written down teaches nobody
              anything, and the next sample goes out exactly the same. */}
          <View style={{ marginTop: 12 }}>
            <SectionLabel style={{ marginBottom: 6 }}>If rejected, what was wrong</SectionLabel>
            <Input
              value={why}
              onChangeText={(v) => {
                setWhy(v);
                setErr(null);
              }}
              placeholder="Dried too slowly, smell, finish…"
            />
          </View>

          {err ? (
            <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
              <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
            </View>
          ) : null}
        </Card>
      ) : null}
    </AppFrame>
  );
}
