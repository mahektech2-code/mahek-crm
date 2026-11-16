import React from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { Badge, T } from '../src/components/ui/primitives';
import { Pill, PillButton, SheetActions } from '../src/components/ui/v3';
import { Icon } from '../src/components/ui/Icon';
import { SearchBox } from '../src/components/ui/book-controls';
import { feedback } from '../src/components/ui/feedback';
import { skuText } from '../src/components/ui/sku';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { color as C, weight, type BadgeTone } from '../src/theme/tokens';
import {
  chaseFor,
  isAwaitingReview,
  isSampleOverdue,
  listFunnelSamples,
  recordNoSample,
  requestLeadSample,
  reviewChaseDays,
  sampleReasons,
  whatIsOwed,
  type FunnelSample,
} from '../src/data/lead-samples';
import { chaseCountSentence } from '../src/lib/sample-chase';
import { getLead } from '../src/data/leads';
import { getCustomer, listCustomersPage, searchProducts, type Customer } from '../src/data/customers';
import { dmy, isoDate, plural } from '../src/lib/format';
import { type CodedOption } from '../src/engines/funnel';
import { useStore } from '../src/state/store';
import { PressableScale, Pop, Presence, Stagger, animateLayoutFor, useShake } from '../src/components/ui/motion';
import { skuLines } from '../src/lib/sku-lines';

/**
 * Samples given out and never followed up are the quietest way a sales day
 * leaks money, so the age of each one is on the row and what is OWED on it is
 * said in words rather than in a colour alone.
 *
 * §15 is the reason the words matter. There are eight states and the gaps
 * between three of them are chased separately, because they are three
 * different failures with three different people to ring: dispatched and not
 * received is the courier, received and not tried is the customer, tried and
 * not reviewed is a call nobody made. "Amber" says none of that.
 */

function toneFor(state: string): BadgeTone {
  switch (state) {
    case 'Converted': return 'success';
    case 'Reviewed': return 'success';
    case 'Awaiting feedback': return 'amber';
    case 'Tried': return 'amber';
    case 'Requested': return 'info';
    case 'Rejected': return 'danger';
    case 'Cancelled': return 'neutral';
    default: return 'teal';
  }
}

/** The shop a sample is for, asked of both books — a lead is not in `customers`. */
async function shopName(id: string): Promise<string> {
  const c = await getCustomer(id);
  if (c) return c.name;
  const l = await getLead(id);
  return l ? l.company?.trim() || l.name : '';
}


/** The flask the V3 artboard heads Samples with. */
function Flask({ size = 26, color = C.primaryDeep, strokeWidth = 2 }: { size?: number; color?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** A 24-grid stroke glyph the shared Icon set does not carry. */
function Glyph({ d, size = 18, color, sw = 2, circles }: { d: string; size?: number; color: string; sw?: number; circles?: [number, number, number][] }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={d} stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
      {circles?.map(([cx, cy, r], i) => (
        <Circle key={i} cx={cx} cy={cy} r={r} stroke={color} strokeWidth={sw} />
      ))}
    </Svg>
  );
}

const SHOP_D = 'M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9h18';
const SHIELD_D = 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9 12l2 2 4-4';
const TRUCK_D = 'M3 7h11v9H3zM14 10h4l3 3v3h-7';
const HAND_D =
  'M7 11V6a1.5 1.5 0 0 1 3 0v5M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V12M16 9a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7c-3 0-5-2-7-5l-2-3a1.5 1.5 0 0 1 2.5-1.5L7 13';

/** The calendar glyph on the Send on button. */
function CalGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Rect x={4} y={5} width={16} height={15} rx={2} stroke={color} strokeWidth={2} />
      <Path d="M4 10h16M9 3v4M15 3v4" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

/**
 * The two-way switch V3 draws for Needs follow-up / All — navy selection, the
 * count beside each word (lime on the selected one).
 */
function Segmented<K extends string>({
  options,
  value,
  onChange,
  bg = C.surface,
  height = 48,
  width,
}: {
  options: readonly { key: K; label: string; count?: number; a11y?: string; icon?: React.ReactNode }[];
  value: K | null;
  onChange: (k: K) => void;
  bg?: string;
  height?: number;
  /** Fixed segment width — the Yes / No switch. Absent, segments share the row. */
  width?: number;
}) {
  return (
    <View
      accessibilityRole="tablist"
      style={{ height, borderRadius: height / 2, backgroundColor: bg, padding: 4, flexDirection: 'row', gap: 4 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => {
              if (!on) feedback('select');
              onChange(o.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={(o.a11y ?? o.label) + (o.count != null ? ', ' + o.count : '')}
            style={{
              ...(width ? { width } : { flex: 1 }),
              borderRadius: (height - 8) / 2,
              backgroundColor: on ? C.navy : 'transparent',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}>
            {o.icon}
            <Text style={[{ fontSize: 14, lineHeight: 20, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>{o.label}</Text>
            {o.count != null ? (
              <Text style={[{ fontSize: 14, lineHeight: 20, color: on ? C.lime : C.muted }, weight(700)]}>{String(o.count)}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The heading over one question on the request sheet. */
function Q({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink }, weight(700), style]}>{children}</Text>;
}

/** A pickable row: the name, the line under it, a ring that ticks. */
function PickRow({
  label,
  sub,
  picked,
  last,
  onPress,
}: {
  label: string;
  sub?: string;
  picked: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: picked }}
      accessibilityLabel={[label, sub].filter(Boolean).join(', ')}
      accessibilityHint={picked ? 'Tap to choose a different one' : undefined}
      style={({ pressed }) => ({
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: C.hairline,
        opacity: pressed ? 0.7 : 1,
      })}>
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 8 }}>
        <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>{label}</Text>
        {sub ? <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }}>{sub}</Text> : null}
      </View>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 2,
          borderColor: picked ? C.primary : '#DCE3EE',
          backgroundColor: picked ? C.primary : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        {picked ? <Icon name="tick" size={12} color="#FFFFFF" strokeWidth={3} /> : null}
      </View>
    </Pressable>
  );
}

/** One of the four non-list states: a card with an icon, a heading and a line. */
function StateCard({
  tone = 'plain',
  icon,
  title,
  line,
}: {
  tone?: 'plain' | 'danger' | 'loading';
  icon?: React.ReactNode;
  title: string;
  line?: string;
}) {
  if (tone === 'loading' || tone === 'danger') {
    const danger = tone === 'danger';
    return (
      <View
        accessible
        accessibilityLabel={title}
        style={{
          backgroundColor: danger ? C.dangerBg : C.surface,
          borderRadius: 20,
          paddingHorizontal: 16,
          paddingVertical: danger ? 18 : 22,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: danger ? 'flex-start' : 'center',
          gap: 10,
        }}>
        {danger ? <Icon name="alert" size={22} color={C.danger} strokeWidth={2} /> : <ActivityIndicator size="small" color={C.primary} />}
        <Text style={[{ fontSize: 15, lineHeight: 21, color: danger ? C.danger : C.ink, flexShrink: 1 }, weight(700)]}>{title}</Text>
      </View>
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={[title, line].filter(Boolean).join('. ')}
      style={{ backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 22, alignItems: 'center' }}>
      {icon}
      <Text style={[{ fontSize: 17, lineHeight: 24, color: C.ink, marginTop: 6, textAlign: 'center' }, weight(800)]}>{title}</Text>
      {line ? <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 4, textAlign: 'center' }}>{line}</Text> : null}
    </View>
  );
}

/** A sample nobody chased is a sample that was given away. */
export default function SamplesScreen() {
  const params = useLocalSearchParams<{ lead?: string; ask?: string }>();
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const custId = useStore((s) => s.custId);

  const [rows, setRows] = React.useState<FunnelSample[]>([]);
  const [names, setNames] = React.useState<Record<string, string>>({});
  /* The day is READ ON EVERY FOCUS rather than frozen at mount. This process
     lives for days — the salesman opens the app he left open last night — and
     a `today` from yesterday makes the overdue flag a day late, in the
     direction that hides what is late. `now` beside it already ticked, so the
     "N days ago" line moved while the flag under it did not. */
  const [today, setToday] = React.useState(() => isoDate(new Date()));
  const [now, setNow] = React.useState(() => Date.now());
  const [askOpen, setAskOpen] = React.useState(params.ask === '1');
  const [reasons, setReasons] = React.useState<CodedOption[]>([]);
  /* §16's ladder, off configuration. The row only needs it to know how many
     named rungs there are — which is what turns "asked three times" from a
     number into "the ladder has been walked and nobody has answered". */
  const [chaseDays, setChaseDays] = React.useState<number[]>([]);
  /* READING is not NOTHING. Both start with an empty array, and "No samples
     out" on the first frame is a definitive sentence about a read still in
     flight. */
  const [status, setStatus] = React.useState<'reading' | 'ready' | 'failed'>('reading');
  /* The list is a WORKLIST by default. Reviewed and cancelled rows draw no
     sentence at all — `whatIsOwed` returns null for them — so an unfiltered
     list buries the two trials that need chasing under a year of finished
     ones, on the one screen that exists because a sample nobody chased is a
     sample that was given away. */
  const [view, setView] = React.useState<'open' | 'all'>('open');

  /*
   * WHICH SHOP THE TRIAL IS FOR, said out loud and never inherited silently.
   *
   * The subject used to be `params.lead ?? custId`, and `custId` is a sticky
   * global that five other screens set and nobody clears — so reached from the
   * More menu, where there is no lead in the route, this requested a trial for
   * whichever shop he last opened, possibly hours earlier, with nothing at any
   * point on the sheet naming it. The seed is now only trusted where the caller
   * opened this sheet in the SAME GESTURE: the customers list's own "Request
   * sample" row sets `custId` and passes `ask=1` immediately before navigating,
   * and that is a shop he has just tapped. Everywhere else he picks one, and
   * either way the name is on the sheet before anything is written.
   */
  const [seedId] = React.useState<string | null>(
    () => params.lead ?? (params.ask === '1' ? custId : null) ?? null,
  );
  const [picked, setPicked] = React.useState<{ id: string; name: string } | null>(
    seedId ? { id: seedId, name: '' } : null,
  );

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    let live = true;
    if (!seedId) return;
    void shopName(seedId).then((name) => {
      if (live && name) setPicked((p) => (p && p.id === seedId ? { id: seedId, name } : p));
    });
    return () => {
      live = false;
    };
  }, [seedId]);

  const load = React.useCallback(() => {
    let live = true;
    setToday(isoDate(new Date()));
    void Promise.all([listFunnelSamples(), sampleReasons(), reviewChaseDays()])
      .then(async ([r, why, chase]) => {
        if (!live) return;
        setRows(r);
        setReasons(why);
        setChaseDays(chase);
        setStatus('ready');
        /* The row says whose shop it is, so the name is fetched for the ids on
           screen rather than joined into every sample query. A lead is not in
           `customers` yet, so both books are asked. */
        const map: Record<string, string> = {};
        for (const id of Array.from(new Set(r.map((x) => x.customerId)))) {
          const name = await shopName(id);
          if (name) map[id] = name;
        }
        if (live) setNames(map);
      })
      .catch(() => {
        if (live) setStatus('failed');
      });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(load);

  const open = rows.filter((x) => whatIsOwed(x) !== null);
  const shown = view === 'open' ? open : rows;

  /*
   * BACK TO THE LEAD HE CAME FROM, not to a lead screen with no lead in it.
   *
   * `useCameFrom` rebuilds the route out of the `from` word alone, so the link
   * labelled "‹ Lead" performed `router.replace('/lead')` with no id and the
   * lead record answered "this lead is not on this phone" — about the lead he
   * had just asked for a sample from. The id is already in the query string
   * here, so the destination is built from it rather than from the word.
   */
  const goBack = () => {
    if (back.from === 'lead' && params.lead) {
      router.replace(`/lead?id=${params.lead}`);
      return;
    }
    back.go();
  };

  const h = HERO.lavender;

  return (
    <AppFrame
      chipsBelowTitle
      title="Samples"
      activeTab={null}
      onBack={goBack}
      showTitle={false}
      hero={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <Flask />
          <Text
            accessibilityRole="header"
            style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: h.ink }, weight(800)]}>
            Samples
          </Text>
        </View>
      }
      contentStyle={{ padding: 14, paddingTop: 16, paddingBottom: 24, gap: 12 }}>
      <PillButton label="Request a sample" variant="primary" height={56} icon="add" onPress={() => setAskOpen(true)} />

      {rows.length > 0 ? (
        <Segmented
          options={[
            { key: 'open', label: 'Needs follow-up', count: open.length },
            { key: 'all', label: 'All', count: rows.length },
          ]}
          value={view}
          onChange={(v) => {
            /* Narrowing to what is owed takes the finished ones out of the
               middle of the list; they fade and the rest close up. */
            if (view !== v) animateLayoutFor(rows.length);
            setView(v);
          }}
        />
      ) : null}

      {status === 'reading' ? (
        <StateCard tone="loading" title="Loading…" />
      ) : status === 'failed' ? (
        <StateCard tone="danger" title="Could not open samples on this phone" />
      ) : rows.length === 0 ? (
        <StateCard
          icon={<Flask size={34} color={C.faint} strokeWidth={1.8} />}
          title="No samples out"
          line="Ask from a shop's record or Request above. A lead gets one once its questions are answered."
        />
      ) : shown.length === 0 ? (
        <StateCard
          icon={<Icon name="tick" size={34} color={C.success} strokeWidth={2} />}
          title="Nothing pending for you"
          line={plural(rows.length, 'sample') + ', all finished. Tap All to see them.'}
        />
      ) : null}

      {shown.map((x, i) => {
        const days = Math.max(0, Math.round((now - x.requestedAt) / 86_400_000));
        const name = names[x.customerId] ?? 'Unknown shop';
        const owed = whatIsOwed(x);
        /* §16 — pure arithmetic over the receipt date and the configured
           ladder, worked out once for the row rather than at each place that
           reads a piece of it. */
        const chase = chaseFor(x, chaseDays, today);
        const overdue = isSampleOverdue(x, today);
        /* HOW MANY TIMES IT HAS BEEN ASKED, on the row itself.

           "Awaiting feedback · 19 days ago" is the same row whether the office
           has rung three times or has not rung at all, and those are the two
           rows on this list a salesman most needs to tell apart. Drawn only
           where a review is actually owed: on a sample still in the godown
           there is nothing to have asked about, and a count there would read
           as a fault.

           The unknown case is deliberately NOT drawn here. The sentence for it
           is a long one about what this phone has and has not been told, and a
           list row is not where that belongs — it is on the record, one tap
           away, with the ladder it explains. A row that said it four hundred
           times would be a row nobody reads. */
        const asked = isAwaitingReview(x) && chase.asked ? chase.asked : 0;
        const askedEnd = asked > 0 && asked >= chase.rungs.length;
        const askedShort = asked >= 3 ? 'Asked ' + asked + '×' : chaseCountSentence(asked);
        const withPills = asked > 0 || overdue;
        const ago = plural(days, 'day') + ' ago';
        /*
         * To the SAMPLE, not to the customer's Samples tab.
         *
         * This routed to the customer record, which is the right answer for a
         * READ — the trial beside the shop's orders and payments. But a sample
         * now has a lifecycle to record: dispatch, courier, the shop
         * confirming receipt, the trial starting and finishing, the verdict.
         * All of that lives on the sample itself, and routing to the customer
         * would leave every one of those screens unreachable. The customer's
         * tab is still there for reading.
         */
        return (
          <Stagger key={x.id} index={i}>
            <PressableScale
              onPress={() => router.push(`/sample?id=${x.id}&from=samples`)}
              accessibilityRole="button"
              accessibilityLabel={[
                name,
                x.state,
                owed,
                ago,
                asked ? chaseCountSentence(asked) + ' with no answer' : null,
                overdue ? 'Feedback is late. Call them.' : null,
              ]
                .filter(Boolean)
                .join('. ')}>
              <View
                style={{
                  backgroundColor: C.surface,
                  borderRadius: 20,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  overflow: 'hidden',
                }}>
                {/* The red edge V3 draws inside the card when feedback is late. */}
                {overdue ? (
                  <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: C.danger }} />
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[{ fontSize: 16, lineHeight: 22, color: C.ink }, weight(700)]}>{name}</T>
                    <T style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 2 }}>
                      {[skuText(x.sku), x.productName, x.cans ? plural(x.cans, 'can') : null].filter(Boolean).join(' · ')}
                    </T>
                  </View>
                  {/* Pops when the office moves it on — dispatched, received —
                      which reaches this list on a pull while it is open. */}
                  <Pop trigger={x.state}>
                    <Badge tone={toneFor(x.state)}>{x.state}</Badge>
                  </Pop>
                </View>

                {withPills ? (
                  <>
                    {owed ? (
                      <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.ink }, weight(600)]}>{owed}</T>
                    ) : null}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                      <Pill icon="clock" text={days + ' d ago'} bg={C.canvas} fg={C.muted} height={28} a11y={ago} />
                      {asked ? (
                        <Pill
                          icon="call"
                          text={askedShort + ' · no answer'}
                          bg={askedEnd ? C.dangerBg : C.warnBg}
                          fg={askedEnd ? C.danger : C.warnInk}
                          height={28}
                          a11y={chaseCountSentence(asked) + ' with no answer'}
                        />
                      ) : null}
                      {overdue ? (
                        <Pill
                          icon="alert"
                          text="Late · call them"
                          bg={C.warnBg}
                          fg={C.warnInk}
                          height={28}
                          a11y="Feedback is late. Call them."
                        />
                      ) : null}
                    </View>
                  </>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: owed ? 10 : 8 }}>
                    <T style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.ink }, weight(600)]}>{owed ?? ''}</T>
                    <View
                      accessible
                      accessibilityLabel={ago}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Icon name="clock" size={13} color={C.muted} strokeWidth={2.4} />
                      <T style={[{ fontSize: 12, lineHeight: 17, color: C.muted }, weight(700)]}>{days + ' d'}</T>
                    </View>
                  </View>
                )}
              </View>
            </PressableScale>
          </Stagger>
        );
      })}

      <RequestSheet
        key={askOpen ? 'ask-open' : 'ask-shut'}
        open={askOpen}
        reasons={reasons}
        shop={picked}
        /* A lead's trial is asked for FROM the lead, so the shop is settled
           before the sheet opens and there is nothing to choose. */
        locked={Boolean(params.lead)}
        onPickShop={setPicked}
        onClose={() => setAskOpen(false)}
        onSubmit={async (form) => {
          if (!picked) return notify('Which shop is the trial for?', 'warn');
          /* Step 1's first question. No starts nothing: it is written on the lead's
             trail and the sheet closes. */
          if (form.requested === 'no') {
            await recordNoSample({ leadId: params.lead ?? null });
            setAskOpen(false);
            return notify('Noted. No sample is being asked for.');
          }
          const r = await requestLeadSample({
            customerId: picked.id,
            leadId: params.lead ?? null,
            productId: form.productId,
            productName: form.productName,
            sendingDate: form.sendingDate,
            sendingMode: form.sendingMode,
          });
          if (!r.ok) return notify(r.message, 'error');
          setAskOpen(false);
          load();
          notify('Requested. The office will approve it before it is sent.');
        }}
      />
    </AppFrame>
  );
}

/**
 * §9 §10 — asking for a trial.
 *
 * Four answers and none of them optional. The product and the quantity are
 * obvious; the APPLICATION is the one people would leave out and the one that
 * decides whether the trial means anything, because a sample given to somebody
 * whose use we do not understand cannot be reviewed — nobody knows what a good
 * result would look like. The reason is a code from the ten, for the same
 * reason every other "why" in this funnel is.
 *
 * The gate that decides whether this may be asked for at all is on the lead
 * record, drawn as a disabled button with the twelve conditions under it. By
 * the time somebody is on this sheet that question has been answered.
 */
function RequestSheet({
  open,
  reasons,
  shop,
  locked,
  onPickShop,
  onClose,
  onSubmit,
}: {
  open: boolean;
  reasons: CodedOption[];
  /** Whose trial this is. Null means nobody has said, and nothing may be sent. */
  shop: { id: string; name: string } | null;
  /** True where the route already settled it — a trial asked for from a lead. */
  locked: boolean;
  onPickShop: (shop: { id: string; name: string } | null) => void;
  onClose: () => void;
  onSubmit: (form: {
    requested: 'yes' | 'no';
    productId: string | null;
    productName: string;
    sendingDate: string;
    sendingMode: 'courier' | 'hand_delivery';
  }) => Promise<void> | void;
}) {
  const [shopQuery, setShopQuery] = React.useState('');
  const [book, setBook] = React.useState<Customer[]>([]);
  const [bookTotal, setBookTotal] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<{ id: string; name: string; formulation: string | null; sku: string | null }[]>([]);
  const [product, setProduct] = React.useState<{ id: string; name: string } | null>(null);
  /* SAMPLE / TRIAL, STEP 1 OF 2: Sample requested?, Product, Sending date, Sending mode. */
  const [requested, setRequested] = React.useState<'yes' | 'no' | null>(null);
  const [sendingDate, setSendingDate] = React.useState<string | null>(null);
  const [calOpen, setCalOpen] = React.useState(false);
  const [sendingMode, setSendingMode] = React.useState<'courier' | 'hand_delivery' | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  /* A ref, not the state, guards the write — see `submit`. */
  const savingRef = React.useRef(false);

  React.useEffect(() => {
    let live = true;
    if (!query.trim()) {
      setHits([]);
      return;
    }
    void searchProducts(query, 8).then((r) => {
      if (live) setHits(r.map((p) => ({ id: p.id, name: p.name, formulation: p.formulation, sku: p.sku })));
    });
    return () => {
      live = false;
    };
  }, [query]);

  /* The book, a page at a time and searchable — which is the only way a shop
     past the first fifty is reachable at all. Not read where the route already
     settled the shop. */
  React.useEffect(() => {
    let live = true;
    if (locked) return;
    void listCustomersPage({ query: shopQuery.trim() || undefined, limit: 50 }).then((page) => {
      if (!live) return;
      setBook(page.rows);
      setBookTotal(page.total);
    });
    return () => {
      live = false;
    };
  }, [locked, shopQuery]);

  /* A refusal shakes the box that says it and buzzes `warning`: on a sheet
     this long the box can sit below the fold, and the buzz is what says look. */
  const refusal = useShake('warning');
  const refuse = (message: string) => {
    setErr(message);
    refusal.shake();
  };

  const submit = async () => {
    /* The sheet closes only once the write returns, so a second tap on a slow
       phone raised a second sample request — and a second approval behind it —
       for one trial. Only one of the two would ever be chased. A ref and not
       the `saving` state, which is a render behind a fast second tap. */
    if (savingRef.current) return;
    if (!shop) return refuse('Which shop is the trial for?');
    if (!requested) return refuse('Has a sample been requested? Answer Yes or No.');
    if (requested === 'yes') {
      if (!product) return refuse('Pick the product from the list.');
      if (!sendingDate) return refuse('Choose the day it is to be sent.');
      if (!sendingMode) return refuse('Courier or Hand Delivery?');
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSubmit({
        requested,
        productId: product?.id ?? null,
        productName: product?.name ?? '',
        sendingDate: sendingDate ?? '',
        sendingMode: sendingMode ?? 'courier',
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
          <Flask size={22} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
            Request a sample
          </Text>
          <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }}>Sample / Trial · Sample Request</Text>
        </View>
      </View>
      {/* WHOSE TRIAL IT IS, on the sheet, before anything is typed. The sheet
          named the product, the cans, the application and the reason and never
          once named the shop — so there was nothing on any screen that could
          have told him the trial was going out to the wrong one. */}
      <View
        accessible
        accessibilityLabel={shop ? 'For ' + (shop.name || 'this shop') : 'Choose the shop below'}
        style={{
          marginTop: 12,
          minHeight: 40,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderRadius: 20,
          backgroundColor: shop ? C.primaryTint : C.warnBg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}>
        <Glyph d={SHOP_D} size={16} color={shop ? C.primaryDeep : C.warnInk} />
        <Text style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: shop ? C.primaryDeep : C.warnInk }, weight(700)]}>
          {shop ? 'For ' + (shop.name || 'this shop') : 'Choose the shop below'}
        </Text>
      </View>
      <View
        accessible
        accessibilityLabel="The office approves it, then it is sent. Later you will write their feedback."
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <Glyph d={SHIELD_D} size={14} color={C.muted} />
        <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>Office approves → sent → you write feedback</Text>
      </View>

      {locked ? null : (
        <View style={{ marginTop: 16 }}>
          <Q>Which shop</Q>
          {shop ? (
            <PickRow
              label={shop.name || 'This shop'}
              picked
              last
              onPress={() => {
                onPickShop(null);
                setShopQuery('');
                setErr(null);
              }}
            />
          ) : (
            <>
              <View style={{ flexDirection: 'row', marginTop: 8 }}>
                <SearchBox
                  value={shopQuery}
                  onChange={(v) => {
                    setShopQuery(v);
                    setErr(null);
                  }}
                  onClear={() => setShopQuery('')}
                  placeholder="Name, area or phone"
                  bg={C.canvas}
                />
              </View>
              <View style={{ marginTop: 4 }}>
                {book.map((c, i) => (
                  <PickRow
                    key={c.id}
                    label={c.name}
                    sub={[c.area, c.city].filter(Boolean).join(' · ') || undefined}
                    picked={false}
                    last={i === book.length - 1}
                    onPress={() => {
                      onPickShop({ id: c.id, name: c.name });
                      setErr(null);
                    }}
                  />
                ))}
                {shopQuery.trim() && book.length === 0 ? (
                  <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center', marginTop: 8 }}>No shop matches that.</Text>
                ) : null}
                {bookTotal > book.length ? (
                  <Text
                    accessibilityLabel={'Showing ' + book.length + ' of ' + bookTotal + '. Search to find more.'}
                    style={{ fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 4 }}>
                    {book.length + ' of ' + bookTotal + ' · search for more'}
                  </Text>
                ) : null}
              </View>
            </>
          )}
        </View>
      )}

      <View style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Q style={{ flex: 1 }}>Sample requested?</Q>
        <Segmented
          options={[
            { key: 'yes', label: 'Yes' },
            { key: 'no', label: 'No' },
          ]}
          value={requested}
          onChange={(v) => {
            setRequested(v);
            setErr(null);
          }}
          bg={C.canvas}
          height={44}
          width={64}
        />
      </View>
      {requested === 'no' ? (
        <Text
          accessibilityLabel="Nothing is started. The answer is noted on this lead, and Step 2 stays locked."
          style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
          Nothing is started. Noted on this lead; Step 2 stays locked.
        </Text>
      ) : null}

      {requested === 'yes' ? (
        <>
          <View style={{ marginTop: 16 }}>
            <Q>Which product</Q>
            {product ? (
              <View style={{ marginTop: 8 }}>
                <PickRow
                  label={product.name}
                  picked
                  last
                  onPress={() => {
                    setProduct(null);
                    setQuery('');
                  }}
                />
              </View>
            ) : (
              <>
                <View style={{ flexDirection: 'row', marginTop: 8 }}>
                  <SearchBox
                    value={query}
                    onChange={(v) => {
                      setQuery(v);
                      setErr(null);
                    }}
                    onClear={() => setQuery('')}
                    placeholder="Thinner, Nano, M5x4"
                    bg={C.canvas}
                  />
                </View>
                <View style={{ gap: 8, marginTop: 8 }}>
                  {hits.map((p) => {
                    /* The SKU's own name leads and the formulation sits under
                       it — the rule the order form runs, in `src/lib/sku-lines.ts`. */
                    const l = skuLines({ name: p.name, formulation: p.formulation });
                    const sub = [skuText(p.sku), l.detail].filter(Boolean).join(' · ');
                    return (
                      <Pressable
                        key={p.id}
                        onPress={() => {
                          setProduct({ id: p.id, name: p.name });
                          setQuery('');
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={[l.lead, sub].filter(Boolean).join(', ')}
                        style={({ pressed }) => ({
                          minHeight: 56,
                          borderRadius: 16,
                          backgroundColor: pressed ? C.primaryTint : '#F7F4FF',
                          paddingHorizontal: 14,
                          paddingVertical: 10,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                        })}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>{l.lead}</Text>
                          {sub ? <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }}>{sub}</Text> : null}
                        </View>
                        <Icon name="add" size={20} color={C.primaryDeep} strokeWidth={2.2} />
                      </Pressable>
                    );
                  })}
                  {query.trim() && hits.length === 0 ? (
                    <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center' }}>No product matches that.</Text>
                  ) : null}
                </View>
              </>
            )}
          </View>

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Q>Send on</Q>
              <Pressable
                onPress={() => setCalOpen(!calOpen)}
                accessibilityRole="button"
                accessibilityLabel={'Sample sending date: ' + (sendingDate ? dmy(sendingDate) : 'choose a day')}
                style={({ pressed }) => ({
                  marginTop: 8,
                  minHeight: 48,
                  paddingVertical: 8,
                  borderRadius: 24,
                  backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                })}>
                <CalGlyph color={C.primaryDeep} />
                <Text style={[{ fontSize: 15, lineHeight: 21, color: C.primaryDeep }, weight(700)]}>
                  {sendingDate ? dmy(sendingDate) : 'Choose a day'}
                </Text>
              </Pressable>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Q>How</Q>
              <View style={{ marginTop: 8, flexDirection: 'row', gap: 6 }}>
                {(
                  [
                    { key: 'courier', label: 'Courier', a11y: 'Courier', d: TRUCK_D, circles: [[7, 18, 1.6], [17, 18, 1.6]] },
                    { key: 'hand_delivery', label: 'Hand', a11y: 'Hand Delivery', d: HAND_D, circles: undefined },
                  ] as const
                ).map((m) => {
                  const on = sendingMode === m.key;
                  return (
                    <Pressable
                      key={m.key}
                      onPress={() => {
                        setSendingMode(m.key);
                        setErr(null);
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={m.a11y}
                      style={{
                        flex: 1,
                        minHeight: 48,
                        paddingVertical: 8,
                        borderRadius: 24,
                        backgroundColor: on ? C.navy : C.canvas,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                      }}>
                      <Glyph
                        d={m.d}
                        size={18}
                        color={on ? C.lime : C.ink}
                        circles={m.circles ? m.circles.map((c) => [...c] as [number, number, number]) : undefined}
                      />
                      <Text style={[{ fontSize: 12, lineHeight: 17, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{m.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>
          <Text
            accessibilityLabel="The day it is planned to go. This does not mark it as sent."
            style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
            Planned day only. Not marked as sent.
          </Text>
          {calOpen ? (
            <View style={{ marginTop: 10 }}>
              <Calendar
                selected={sendingDate ?? ''}
                onPick={(iso) => {
                  setSendingDate(iso);
                  setCalOpen(false);
                  setErr(null);
                }}
              />
            </View>
          ) : null}
        </>
      ) : null}

      <Presence show={!!err}>
        <Animated.View
          style={[
            {
              marginTop: 12,
              backgroundColor: C.dangerBg,
              borderRadius: 16,
              paddingHorizontal: 14,
              paddingVertical: 12,
              flexDirection: 'row',
              gap: 8,
            },
            refusal.style,
          ]}>
          <Icon name="alert" size={18} color={C.danger} strokeWidth={2} />
          <T style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.danger }, weight(600)]}>{err}</T>
        </Animated.View>
      </Presence>

      <SheetActions
        onCancel={onClose}
        label={saving ? 'Sending…' : requested === 'no' ? 'Note: no sample' : 'Request sample'}
        busy={saving}
        onPress={submit}
      />
    </BottomSheet>
  );
}
