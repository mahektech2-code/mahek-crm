import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, PrimaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { NavigateButton } from '../src/components/ui/navigate';
import { color as C, radius, weight } from '../src/theme/tokens';
import { whatIsNearby, type NearbyAnswer } from '../src/data/nearby';
/* No `navigateTo` here either — both buttons on this screen are
   `NavigateButton`, so one failure message cannot drift from the other. */
import { inrFromPaise } from '../src/lib/format';
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

/**
 * How many of them are drawn at once.
 *
 * The list was every pinned shop inside the circle that carried a reason, and
 * at the widest radius on a real book that is hundreds of cards — each with two
 * buttons and four text nodes — mounted in one pass inside the frame's own
 * scroll view. Seconds of freeze on open, on the one screen whose whole point
 * is a quick answer while somebody is standing in a lane. Nobody walks to the
 * hundredth-nearest shop off this screen; what a cap costs is a row he would
 * have reached by scrolling, and the sentence underneath says it is there.
 */
const NEARBY_PAGE = 30;

export default function Nearby() {
  const back = useCameFrom('customers');
  const set = useStore((s) => s.set);

  const [answer, setAnswer] = React.useState<NearbyAnswer | null>(null);
  /* `within`, not `radius` — the design tokens already export a `radius`
     scale, and shadowing it here made `radius.xl` resolve to a number. */
  const [within, setWithin] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(true);
  /* A read that threw. There was no rejection path at all, so a SQLite or a
     config failure left `busy` true and the screen reading "Looking…" for
     ever — which is a broken handset with nothing on it to press. */
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback((metres?: number) => {
    setBusy(true);
    setFailed(false);
    void whatIsNearby(metres)
      .then((a) => {
        setAnswer(a);
        setWithin(a.radiusMetres);
        setBusy(false);
      })
      .catch(() => {
        setBusy(false);
        setFailed(true);
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
      ) : failed ? (
        <Card style={{ marginTop: 16 }}>
          <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>That did not come back</T>
          <T s="caption" style={{ marginTop: 4 }}>
            Nothing is wrong with your book — the list could not be worked out just now.
          </T>
          <DashedButton
            label="Try again"
            onPress={() => load(within ?? undefined)}
            style={{ marginTop: 12 }}
          />
        </Card>
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
              {/* THE ONE Navigate, not a third hand-rolled one. `navigate.tsx`
                  exists precisely so a second `openMaps` call site cannot let
                  the failure message on one screen drift from the other's — and
                  these two were worse than drift: they called `navigateTo`,
                  which needs a coordinate and falls back to the clipboard,
                  while every other Navigate in the app searches the shop's name
                  and town when there is no pin. Half this book has no pin, and
                  both of these began `if (!coords) return` — a tap that
                  acknowledged nothing at all. */}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <NavigateButton
                  lat={answer.best.shop.coords?.lat}
                  lng={answer.best.shop.coords?.lng}
                  name={answer.best.shop.name}
                  variant="button"
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
              : /* The advice only where there IS a wider circle. On the widest
                   the sentence named the one action that does not exist, which
                   is an empty state whose only instruction is a dead end. */
                'Nothing within ' +
                metresLabel(answer.radiusMetres) +
                ' has anything outstanding.' +
                (answer.radiusMetres < Math.max(...answer.options, 0) ? ' Try a wider circle.' : '')}
          </T>

          <View style={{ gap: 12, marginTop: 8 }}>
            {answer.shops.slice(0, NEARBY_PAGE).map((r) => (
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
                    {inrFromPaise(r.shop.outstandingPaise) + ' outstanding'}
                  </T>
                ) : null}

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <NavigateButton
                    lat={r.shop.coords?.lat}
                    lng={r.shop.coords?.lng}
                    name={r.shop.name}
                    variant="button"
                    style={{ flex: 1 }}
                  />
                  <DashedButton label="Open" onPress={() => open(r.shop.id)} style={{ flex: 1 }} />
                </View>
              </Card>
            ))}
          </View>

          {/* What the list is a slice OF — the same sentence the pick screen
              prints for the same reason. A capped list that counts itself is
              how a screen shows thirty of a hundred and says nothing. */}
          {answer.shops.length > NEARBY_PAGE ? (
            <T s="caption" style={{ marginTop: 12, textAlign: 'center' }}>
              {`${NEARBY_PAGE} of ${answer.shops.length}, best first. Narrow the circle for the ones around you.`}
            </T>
          ) : null}
        </>
      )}
    </AppFrame>
  );
}
