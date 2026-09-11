import React from 'react';
import { View, Pressable } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, Card, Choice, DashedButton, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { BottomSheet } from '../src/components/ui/overlays';
import { color as C, radius, weight, type BadgeTone } from '../src/theme/tokens';
import {
  isSampleOverdue,
  listFunnelSamples,
  requestLeadSample,
  sampleReasons,
  whatIsOwed,
  type FunnelSample,
} from '../src/data/lead-samples';
import { VoiceField } from '../src/components/ui/dictate';
import { getLead } from '../src/data/leads';
import { getCustomer, listCustomersPage, searchProducts, type Customer } from '../src/data/customers';
import { isoDate, plural } from '../src/lib/format';
import { type CodedOption } from '../src/engines/funnel';
import { useStore } from '../src/state/store';

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
    void Promise.all([listFunnelSamples(), sampleReasons()])
      .then(async ([r, why]) => {
        if (!live) return;
        setRows(r);
        setReasons(why);
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

  return (
    <AppFrame title="Samples" activeTab={null} onBack={goBack} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={goBack} />

      <DashedButton label="+ Request a sample" tone="primary" onPress={() => setAskOpen(true)} />

      {rows.length > 0 ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
          <Choice
            label={'Needs chasing · ' + open.length}
            selected={view === 'open'}
            onPress={() => setView('open')}
            style={{ flex: 1 }}
          />
          <Choice
            label={'All · ' + rows.length}
            selected={view === 'all'}
            onPress={() => setView('all')}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}

      {status === 'reading' ? (
        <Card style={{ marginTop: 16, paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>Reading…</T>
        </Card>
      ) : status === 'failed' ? (
        <Card style={{ marginTop: 16, paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>
            The samples could not be read off this phone
          </T>
        </Card>
      ) : rows.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>No samples out</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            A trial is asked for from a lead once its twelve questions are answered.
          </T>
        </Card>
      ) : shown.length === 0 ? (
        <Card style={{ marginTop: 16, paddingVertical: 32 }}>
          <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>Nothing waiting on you</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
            {plural(rows.length, 'sample') + ' here, all of them finished. Tap All to read them.'}
          </T>
        </Card>
      ) : null}

      <View style={{ gap: 12, marginTop: 16 }}>
        {shown.map((x) => {
          const days = Math.max(0, Math.round((now - x.requestedAt) / 86_400_000));
          const name = names[x.customerId] ?? 'Unknown shop';
          const owed = whatIsOwed(x);
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
            <Pressable
              key={x.id}
              onPress={() => router.push(`/sample?id=${x.id}&from=samples`)}
              accessibilityRole="button">
              <Card style={isSampleOverdue(x, today) ? { borderLeftWidth: 3, borderLeftColor: C.danger } : undefined}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{name}</T>
                    <T s="caption" style={{ marginTop: 2 }}>
                      {[x.productName, x.cans ? plural(x.cans, 'can') : null].filter(Boolean).join(' · ')}
                    </T>
                  </View>
                  <Badge tone={toneFor(x.state)}>{x.state}</Badge>
                </View>

                {owed ? (
                  <T style={[{ fontSize: 14, lineHeight: 20, marginTop: 10, color: C.ink }, weight(500)]}>{owed}</T>
                ) : null}

                <T s="caption" style={{ marginTop: 4 }}>{plural(days, 'day') + ' ago'}</T>

                {isSampleOverdue(x, today) ? (
                  <T style={[{ fontSize: 14, color: C.warnInk, marginTop: 4 }, weight(500)]}>
                    Feedback is late — worth a call
                  </T>
                ) : null}
              </Card>
            </Pressable>
          );
        })}
      </View>

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
          if (!picked) return notify('Which shop is the trial for?');
          const r = await requestLeadSample({
            customerId: picked.id,
            leadId: params.lead ?? null,
            productId: form.productId,
            productName: form.productName,
            cans: form.cans,
            application: form.application,
            reasonCode: form.reasonCode,
          });
          if (!r.ok) return notify(r.message);
          setAskOpen(false);
          load();
          notify('Asked for · the office approves it before it goes out');
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
    productId: string | null;
    productName: string;
    cans: number;
    application: string;
    reasonCode: string;
  }) => Promise<void> | void;
}) {
  const [shopQuery, setShopQuery] = React.useState('');
  const [book, setBook] = React.useState<Customer[]>([]);
  const [bookTotal, setBookTotal] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<{ id: string; name: string; formulation: string | null }[]>([]);
  const [product, setProduct] = React.useState<{ id: string; name: string } | null>(null);
  const [cans, setCans] = React.useState('1');
  const [application, setApplication] = React.useState('');
  const [reasonCode, setReasonCode] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    if (!query.trim()) {
      setHits([]);
      return;
    }
    void searchProducts(query, 8).then((r) => {
      if (live) setHits(r.map((p) => ({ id: p.id, name: p.name, formulation: p.formulation })));
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

  const submit = async () => {
    /* The sheet closes only once the write returns, so a second tap on a slow
       phone raised a second sample request — and a second approval behind it —
       for one trial. Only one of the two would ever be chased. */
    if (saving) return;
    if (!shop) return setErr('Which shop is the trial for?');
    if (!product) return setErr('Which product is the trial of?');
    if (!(Number(cans) > 0)) return setErr('How many cans?');
    if (!application.trim()) return setErr('What will they use it on? Without that nobody can judge the trial.');
    if (!reasonCode) return setErr('Say why they want a trial.');
    setSaving(true);
    try {
      await onSubmit({
        productId: product.id,
        productName: product.name,
        cans: Number(cans),
        application: application.trim(),
        reasonCode,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        Request a sample
      </T>
      {/* WHOSE TRIAL IT IS, on the sheet, before anything is typed. The sheet
          named the product, the cans, the application and the reason and never
          once named the shop — so there was nothing on any screen that could
          have told him the trial was going out to the wrong one. */}
      <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 4 }, weight(500)]}>
        {shop ? 'For ' + (shop.name || 'this shop') : 'Pick the shop below'}
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        The office approves it, then it is dispatched. You will be asked what they thought.
      </T>

      {locked ? null : (
        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>Which shop</SectionLabel>
          {shop ? (
            <Choice
              label={shop.name || 'This shop'}
              selected
              onPress={() => { onPickShop(null); setShopQuery(''); setErr(null); }}
              style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
            />
          ) : (
            <>
              <Input
                value={shopQuery}
                onChangeText={(v) => { setShopQuery(v); setErr(null); }}
                placeholder="Search your book by name, area or phone"
              />
              <View style={{ gap: 8, marginTop: 8 }}>
                {book.map((c) => (
                  <Choice
                    key={c.id}
                    label={c.name}
                    sub={[c.area, c.city].filter(Boolean).join(' · ') || undefined}
                    selected={false}
                    onPress={() => { onPickShop({ id: c.id, name: c.name }); setErr(null); }}
                    style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
                  />
                ))}
                {shopQuery.trim() && book.length === 0 ? (
                  <T s="caption">No shop in your book matches that.</T>
                ) : null}
                {bookTotal > book.length ? (
                  <T s="caption">
                    {'Showing ' + book.length + ' of ' + bookTotal + ' — search for the rest.'}
                  </T>
                ) : null}
              </View>
            </>
          )}
        </View>
      )}

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Which product</SectionLabel>
        {product ? (
          <Choice
            label={product.name}
            selected
            onPress={() => { setProduct(null); setQuery(''); }}
            style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
          />
        ) : (
          <>
            <Input value={query} onChangeText={(v) => { setQuery(v); setErr(null); }} placeholder="Thinner, Nano, M5x4" />
            <View style={{ gap: 8, marginTop: 8 }}>
              {hits.map((p) => (
                <Choice
                  key={p.id}
                  label={p.name}
                  sub={p.formulation ?? undefined}
                  selected={false}
                  onPress={() => { setProduct({ id: p.id, name: p.name }); setQuery(''); }}
                  style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
                />
              ))}
              {query.trim() && hits.length === 0 ? <T s="caption">Nothing in the catalogue matches that.</T> : null}
            </View>
          </>
        )}
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>How many cans</SectionLabel>
        <Input value={cans} onChangeText={(v) => { setCans(v.replace(/[^\d]/g, '')); setErr(null); }} keyboardType="number-pad" />
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What they will use it on</SectionLabel>
        {/* Prose, so it gets the microphone: this is the sample's own "why he
            wants it", typed one-handed in a shop by somebody who speaks the
            answer far better than he writes it. */}
        <VoiceField
          value={application}
          onChangeText={(v) => { setApplication(v); setErr(null); }}
          placeholder="Spray booth, furniture polish, wooden doors"
        />
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Why they want a trial</SectionLabel>
        <View style={{ gap: 8 }}>
          {reasons.map((o) => (
            <Choice
              key={o.code}
              label={o.label}
              selected={reasonCode === o.code}
              onPress={() => { setReasonCode(o.code); setErr(null); }}
              style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
            />
          ))}
        </View>
      </View>

      {err ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton
          label={saving ? 'Asking…' : 'Ask for it'}
          disabled={saving}
          onPress={submit}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}
