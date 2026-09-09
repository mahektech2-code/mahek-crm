import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, PrimaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { color as C, radius, weight } from '../src/theme/tokens';
import { whatIsNearby, type NearbyAnswer } from '../src/data/nearby';
import { navigateTo } from '../src/lib/messaging';
import { inr } from '../src/lib/format';
import { useStore } from '../src/state/store';

/**
 * §E, §F and §G of the mapping brief — the answer, without the map.
 *
 * The map itself is blocked on a native dependency and a new APK on every
 * handset. What a salesman standing in a lane actually wants from it is not a
 * picture: it is "who else is near me, and which one first". That needs no
 * tiles, works with one bar, and is what this screen is.
 *
 * The order is deliberately NOT by distance. The brief says so in as many
 * words, and the reason each shop is on the list is printed beside it — a
 * ranking nobody can get behind is one they stop believing the first time it
 * surprises them.
 */

function metresLabel(m: number): string {
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
}

export default function Nearby() {
  const back = useCameFrom('customers');
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);

  const [answer, setAnswer] = React.useState<NearbyAnswer | null>(null);
  /* `within`, not `radius` — the design tokens already export a `radius`
     scale, and shadowing it here made `radius.xl` resolve to a number. */
  const [within, setWithin] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(true);

  const load = React.useCallback((metres?: number) => {
    setBusy(true);
    void whatIsNearby(metres).then((a) => {
      setAnswer(a);
      setWithin(a.radiusMetres);
      setBusy(false);
    });
  }, []);

  React.useEffect(() => load(), [load]);

  const open = (id: string) => {
    set({ custId: id, pTab: 0 });
    router.push('/customer');
  };

  return (
    <AppFrame title="Near me" activeTab="customers" onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 32 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* The radii the office configured, not a list written into this screen. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {(answer?.options ?? []).map((m) => (
          <Choice
            key={m}
            label={metresLabel(m)}
            selected={within === m}
            onPress={() => load(m)}
            style={{ paddingHorizontal: 16 }}
          />
        ))}
      </View>

      {busy ? (
        <T s="caption" style={{ marginTop: 16 }}>Looking…</T>
      ) : !answer?.from ? (
        /* No fix is a recorded fact and the screen says WHICH — refused, off, or
           simply not known yet. "Nothing nearby" would read as a book with no
           shops in it, which is a different and much worse thing to believe. */
        <Card style={{ marginTop: 16 }}>
          <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
            {answer?.reason === 'denied'
              ? 'Location permission is off'
              : answer?.reason === 'off'
                ? 'Location is switched off'
                : 'No position yet'}
          </T>
          <T s="caption" style={{ marginTop: 4 }}>
            {answer?.reason === 'denied'
              ? 'Turn it on for MBOS in your phone settings and come back.'
              : 'Step outside for a moment — this needs a fix to measure from.'}
          </T>
        </Card>
      ) : (
        <>
          {/* §G — one recommendation, and why. It is the head of the same list
              below rather than a second calculation, so the two can never
              disagree about which shop. */}
          {answer.best ? (
            <Card style={{ marginTop: 16, borderLeftWidth: 3, borderLeftColor: C.primary }}>
              <SectionLabel>Next best visit</SectionLabel>
              <T style={[{ fontSize: 17, lineHeight: 23, color: C.ink, marginTop: 4 }, weight(600)]}>
                {answer.best.shop.name}
              </T>
              <T s="caption" style={{ marginTop: 2 }}>
                {metresLabel(answer.best.metres) + ' · ' + answer.best.reasons.join(' · ')}
              </T>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <DashedButton
                  label="Navigate"
                  onPress={async () => {
                    const c = answer.best!.shop.coords;
                    if (!c) return;
                    const r = await navigateTo(c, answer.best!.shop.name);
                    if (r.status === 'copied') notify(r.reason);
                  }}
                  style={{ flex: 1 }}
                />
                <PrimaryButton
                  label="Open the shop"
                  onPress={() => open(answer.best!.shop.id)}
                  style={{ flex: 1, borderRadius: radius.xl }}
                />
              </View>
            </Card>
          ) : null}

          <T s="caption" style={{ marginTop: 16 }}>
            {answer.shops.length
              ? answer.shops.length + ' worth stopping at within ' + metresLabel(answer.radiusMetres)
              : 'Nothing within ' + metresLabel(answer.radiusMetres) + ' has anything outstanding. Try a wider circle.'}
          </T>

          <View style={{ gap: 12, marginTop: 8 }}>
            {answer.shops.map((r) => (
              <Card key={r.shop.id}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
                      {r.shop.name}
                    </T>
                    {/* Why it is on the list. A ranking nobody can get behind is
                        one they stop believing the first time it surprises them. */}
                    <T s="caption" style={{ marginTop: 2 }}>{r.reasons.join(' · ')}</T>
                  </View>
                  <Badge tone="neutral">{metresLabel(r.metres)}</Badge>
                </View>

                {r.shop.outstandingPaise > 0 ? (
                  <T style={[{ fontSize: 14, marginTop: 8, color: C.danger }, weight(500)]}>
                    {inr(r.shop.outstandingPaise / 100) + ' outstanding'}
                  </T>
                ) : null}

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <DashedButton
                    label="Navigate"
                    onPress={async () => {
                      if (!r.shop.coords) return;
                      const out = await navigateTo(r.shop.coords, r.shop.name);
                      if (out.status === 'copied') notify(out.reason);
                    }}
                    style={{ flex: 1 }}
                  />
                  <DashedButton label="Open" onPress={() => open(r.shop.id)} style={{ flex: 1 }} />
                </View>
              </Card>
            ))}
          </View>
        </>
      )}
    </AppFrame>
  );
}
