import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { feedback } from '../src/components/ui/feedback';
import { NavigateButton } from '../src/components/ui/navigate';
import { DashedAdd, GroupCard, Pill, PillButton } from '../src/components/ui/v3';
import { color as C, weight } from '../src/theme/tokens';
import { whatIsNearby, type NearbyAnswer } from '../src/data/nearby';
import { openLocationSettings } from '../src/native/location';
/* No `navigateTo` here either — both buttons on this screen are
   `NavigateButton`, so one failure message cannot drift from the other. */
import { inrFromPaise, plural, shopName } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { Appear, Stagger } from '../src/components/ui/motion';

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

  /* A lead opens `/lead`, where its ladder and gates are — the same rule the
     Customers list follows. This opened the customer record for every shop,
     which for a lead is a page of empty ledgers. */
  const open = (shop: { id: string; leadStage: string | null }) => {
    set({ custId: shop.id, pTab: 0 });
    const stage = shop.leadStage?.toLowerCase() ?? '';
    if (stage && stage !== 'converted' && stage !== 'won') router.push(`/lead?id=${shop.id}&from=nearby`);
    else router.push('/customer');
  };

  const isLead = (shop: { leadStage: string | null }) => {
    const stage = shop.leadStage?.toLowerCase() ?? '';
    return !!stage && stage !== 'converted' && stage !== 'won';
  };

  const hero = (
    /* The radii the office configured, not a list written into this screen. */
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
      {(answer?.options ?? []).map((m) => {
        const on = within === m;
        return (
          <Pressable
            key={m}
            onPress={() => {
              if (!on) feedback('select');
              load(m);
            }}
            accessibilityRole="radio"
            accessibilityLabel={'Within ' + metresLabel(m)}
            accessibilityState={{ selected: on }}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 64,
              minHeight: 44,
              paddingVertical: 6,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? C.navy : pressed ? C.primaryTint : C.surface,
            })}>
            <T style={[{ fontSize: 14, color: on ? C.lime : C.lavenderInk }, weight(700)]}>{metresLabel(m)}</T>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <AppFrame
      title="Near me"
      activeTab="customers"
      onBack={back.go}
      hero={hero}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 32, gap: 10 }}>
      {busy ? (
        <T style={{ fontSize: 13, color: C.muted, paddingHorizontal: 6 }}>Searching…</T>
      ) : failed ? (
        <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
          <T style={[{ fontSize: 16, color: C.ink }, weight(800)]}>Could not load the list</T>
          <T style={{ marginTop: 4, fontSize: 13, lineHeight: 18, color: C.muted }}>
            Your customers are safe. The list could not be made right now.
          </T>
          <DashedAdd label="Try again" onPress={() => load(within ?? undefined)} style={{ marginTop: 10 }} />
        </View>
      ) : !answer?.from ? (
        /* No fix is a recorded fact and the screen says WHICH — refused, off, or
           simply not known yet. "Nothing nearby" would read as a book with no
           shops in it, which is a different and much worse thing to believe. */
        <View style={{ backgroundColor: C.warnBg, borderRadius: 22, padding: 16, flexDirection: 'row', gap: 12 }}>
          <Icon name="locate" size={24} color={C.warnInk} strokeWidth={2} />
          <View style={{ flex: 1 }}>
            <T style={[{ fontSize: 16, color: C.ink }, weight(800)]}>
              {answer?.reason === 'denied'
                ? 'Location permission is off'
                : answer?.reason === 'off'
                  ? 'Location is switched off'
                  : 'No GPS yet'}
            </T>
            <T style={{ marginTop: 4, fontSize: 13, lineHeight: 18, color: C.muted }}>
              {answer?.reason === 'denied'
                ? 'Allow location for Mahek MBOS in your phone settings. Then come back.'
                : answer?.reason === 'off'
                  ? 'Turn on Location from the top of your phone screen. Then come back.'
                  : 'Step outside for a minute so GPS can find you.'}
            </T>
            {/* "Then come back" had nothing to come back TO: the screen read its
                fix once on open, so the only way to try again was to leave
                and re-enter. The switch is offered where one cures it, and
                every case can ask again from here. */}
            {answer?.reason === 'denied' || answer?.reason === 'off' ? (
              <DashedAdd
                label={answer.reason === 'denied' ? 'Allow location' : 'Turn location on'}
                onPress={() => void openLocationSettings(answer.reason === 'denied' ? 'permission' : 'services_off')}
                style={{ marginTop: 10 }}
              />
            ) : null}
            <DashedAdd label="Try again" onPress={() => load(within ?? undefined)} style={{ marginTop: 10 }} />
          </View>
        </View>
      ) : (
        <>
          {/* §G — one recommendation, and why. It is the head of the same list
              below rather than a second calculation, so the two can never
              disagree about which shop. */}
          {answer.best ? (
            <Appear>
              <View style={{ backgroundColor: C.navy, borderRadius: 24, padding: 18 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Icon name="spark" size={16} color={C.lime} strokeWidth={2} />
                  <T style={[{ flex: 1, fontSize: 13, color: C.lime }, weight(700)]}>Next best visit</T>
                  <Icon name="nav" size={14} color="#FFFFFF" strokeWidth={2} />
                  <T style={[{ flexShrink: 1, fontSize: 13, color: '#FFFFFF' }, weight(700)]}>{metresLabel(answer.best.metres)}</T>
                </View>
                <T style={[{ fontSize: 22, lineHeight: 28, letterSpacing: -0.44, color: '#FFFFFF', marginTop: 10 }, weight(800)]}>
                  {shopName(answer.best.shop.name)}
                </T>
                {answer.best.reasons.length || answer.best.shop.outstandingPaise > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                    {answer.best.reasons.map((r) => (
                      <Pill key={r} text={r} bg="rgba(255,255,255,0.1)" fg="#FFFFFF" />
                    ))}
                    {answer.best.shop.outstandingPaise > 0 ? (
                      <Pill
                        text={inrFromPaise(answer.best.shop.outstandingPaise)}
                        icon="wallet"
                        bg="rgba(255,107,94,0.18)"
                        fg="#FF8A7E"
                        a11y={inrFromPaise(answer.best.shop.outstandingPaise) + ' outstanding'}
                      />
                    ) : null}
                  </View>
                ) : null}
                {/* THE ONE Navigate, not a hand-rolled one. `navigate.tsx` exists
                    precisely so a second `openMaps` call site cannot let the
                    failure message on one screen drift from the other's — and
                    every Navigate in the app searches the shop's name and town
                    when there is no pin, which is half this book. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
                  <NavigateButton
                    lat={answer.best.shop.coords?.lat}
                    lng={answer.best.shop.coords?.lng}
                    name={answer.best.shop.name}
                    variant="icon"
                  />
                  <PillButton
                    label={isLead(answer.best.shop) ? 'Open lead' : 'Open shop'}
                    variant="lime"
                    block
                    height={56}
                    onPress={() => open(answer.best!.shop)}
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            </Appear>
          ) : null}

          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}>
            <T style={[{ flex: 1, fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
              {answer.shops.length
                ? plural(answer.shops.length, 'shop') + ' within ' + metresLabel(answer.radiusMetres)
                : /* The advice only where there IS a wider circle. On the widest
                     the sentence named the one action that does not exist. */
                  'Nothing within ' +
                  metresLabel(answer.radiusMetres) +
                  ' has anything pending.' +
                  (answer.radiusMetres < Math.max(...answer.options, 0) ? ' Try a bigger distance.' : '')}
            </T>
            {answer.shops.length ? <T style={{ flexShrink: 1, fontSize: 12, color: C.muted }}>best first</T> : null}
          </View>

          {answer.shops.length ? (
            <GroupCard style={{ paddingHorizontal: 12 }}>
              {/* Each radius re-reads and re-mounts the list, so the cascade plays
                  for a new circle and not for a pull that changed nothing. */}
              {answer.shops.slice(0, NEARBY_PAGE).map((r, i) => (
                <Stagger key={r.shop.id} index={i + 1}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 72, paddingVertical: 10 }}>
                    <Pressable
                      onPress={() => open(r.shop)}
                      accessibilityRole="button"
                      accessibilityLabel={
                        shopName(r.shop.name) +
                        ', ' +
                        metresLabel(r.metres) +
                        (r.reasons.length ? ', ' + r.reasons.join(', ') : '') +
                        (r.shop.outstandingPaise > 0 ? ', ' + inrFromPaise(r.shop.outstandingPaise) + ' outstanding' : '')
                      }
                      style={({ pressed }) => ({ flex: 1, minWidth: 0, opacity: pressed ? 0.7 : 1 })}>
                      <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(700)]}>
                        {shopName(r.shop.name)}
                      </T>
                      {/* Why it is on the list. A ranking nobody can get behind is
                          one they stop believing the first time it surprises them. */}
                      <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
                        {[metresLabel(r.metres), ...r.reasons].join(' · ')}
                      </T>
                      {r.shop.outstandingPaise > 0 ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Icon name="wallet" size={12} color={C.danger} strokeWidth={2} />
                          <T style={[{ flexShrink: 1, fontSize: 13, color: C.danger }, weight(700)]}>{inrFromPaise(r.shop.outstandingPaise)}</T>
                        </View>
                      ) : null}
                    </Pressable>
                    <NavigateButton lat={r.shop.coords?.lat} lng={r.shop.coords?.lng} name={r.shop.name} variant="icon" />
                    <Pressable
                      onPress={() => open(r.shop)}
                      accessibilityRole="button"
                      accessibilityLabel={isLead(r.shop) ? 'Open lead' : 'Open'}
                      style={({ pressed }) => ({
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
                      })}>
                      <Icon name="forward" size={18} color={C.primaryDeep} strokeWidth={2} />
                    </Pressable>
                  </View>
                </Stagger>
              ))}
            </GroupCard>
          ) : null}

          {/* What the list is a slice OF — the same sentence the pick screen
              prints for the same reason. */}
          {answer.shops.length > NEARBY_PAGE ? (
            <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, textAlign: 'center' }}>
              {`${NEARBY_PAGE} of ${answer.shops.length}, best first · pick a smaller distance`}
            </T>
          ) : null}
        </>
      )}
    </AppFrame>
  );
}
