import React from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Input, ListCard, PrimaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, shadow, tabular, type, weight } from '../src/theme/tokens';
import { inr, plural } from '../src/lib/format';
import {
  billingChoicesFor,
  frequentProducts,
  searchProducts,
  starterProducts,
  type BillingChoice,
} from '../src/data/customers';
import { assessCart, saveOrder, type CartLine, type OrderAssessment } from '../src/data/orders';
import { useCustomer, useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';

/**
 * The order screen.
 *
 * Two things here are the whole point. The frequent strip is what makes an
 * order takeable while the customer is talking — his usual three products are
 * one tap each, before any search happens. And the credit bar is what stops
 * the order being a surprise later: the limit is checked here, in front of the
 * customer, rather than by an office that declines it two days on.
 *
 * A credit-blocked customer is the ONE outright refusal in this app, and it
 * happens before the cart rather than after it: letting somebody spend two
 * minutes assembling twelve lines and then refusing is the wrong shape.
 * Everything else — over the limit, over the approval threshold — flags, routes
 * to approval, and still saves.
 *
 * The catalogue is never shipped here whole. The panel is handed what is worth
 * offering unprompted — his own frequent products and a short starter list —
 * and everything else arrives a search at a time. What it has seen it keeps,
 * so a line already on the order keeps its name after the search that found it
 * is typed over.
 */

type Product = {
  id: string;
  name: string;
  packSize?: string | null;
  cansPerBox?: number | null;
  millilitresPerCan?: number | null;
  sellingPricePaise?: number | null;
  formulation?: string | null;
  brand?: string | null;
};

export default function OrderScreen() {
  const back = useCameFrom('more');
  const c = useCustomer();
  const boot = useBoot();
  const cart = useStore((s) => s.cart);
  const oQ = useStore((s) => s.oQ);
  const set = useStore((s) => s.set);
  const setQty = useStore((s) => s.setQty);
  const dropLine = useStore((s) => s.dropLine);
  const notify = useStore((s) => s.notify);
  const markVisitDone = useStore((s) => s.markVisitDone);

  /* Every product this panel has been shown, by id. A cart line whose product
     fell out of the last search still has a name, a pack and a rate. */
  const [known, setKnown] = React.useState<Record<string, Product>>({});
  const [frequent, setFrequent] = React.useState<Product[]>([]);
  const [results, setResults] = React.useState<Product[]>([]);
  /** Which query the rows in `results` answer. Anything else is stale. */
  const [resultsFor, setResultsFor] = React.useState<string | null>(null);
  const [assessment, setAssessment] = React.useState<OrderAssessment | null>(null);

  /* ------------------------------------------- who we bill, who we deliver to
   *
   * The customer whose screen this is, is where the GOODS go — the salesman is
   * standing in it. Who gets INVOICED is a second question, and on a shop
   * served through a distributor it has a different answer.
   *
   * `billing` is the chosen id and starts null, meaning "not worked out yet";
   * the effect below settles it to the best answer the arrangement gives, and
   * the salesman can change it. It is deliberately not defaulted to the shop:
   * doing that would flash a wrong biller and a wrong credit bar for a frame
   * on exactly the accounts this exists for.
   */
  const [billingOptions, setBillingOptions] = React.useState<BillingChoice[] | null>(null);
  const [billing, setBilling] = React.useState<string | null>(null);
  const [pickingBiller, setPickingBiller] = React.useState(false);

  const remember = React.useCallback((rows: Product[]) => {
    setKnown((prev) => {
      const next = { ...prev };
      for (const r of rows) next[r.id] = r;
      return next;
    });
  }, []);

  const custId = c?.id ?? null;

  /* The arrangement, read once per customer. It came down with the pull, so
     this is a local read and works with no signal. */
  React.useEffect(() => {
    let live = true;
    if (!c) {
      setBillingOptions(null);
      setBilling(null);
      return;
    }
    void billingChoicesFor(c).then((options) => {
      if (!live) return;
      setBillingOptions(options);
      /* The first option that can actually be billed. On a direct customer
         that is the shop itself; on a third-party one it is the primary
         distributor, falling through to the shop where his distributor is
         somebody else's account. */
      setBilling(options.find((o) => o.onBook)?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [c]);

  /** Who is being invoiced. Every credit figure on this screen is theirs. */
  const biller = billingOptions?.find((o) => o.id === billing) ?? null;
  /** Where the goods go, when that is not where the bill goes. */
  const deliverTo = c && billing && billing !== c.id ? c : null;

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!custId) return;
      void Promise.all([frequentProducts(custId), starterProducts()]).then(([f, starter]) => {
        if (!live) return;
        setFrequent(f);
        remember([...f, ...starter]);
      });
      return () => {
        live = false;
      };
    }, [custId, remember]),
  );

  const query = (oQ || '').trim();

  /* The search runs in the database. An empty box is not a search — it is the
     starter list, which is already on screen. Whether the answer on screen is
     the answer to what is typed is DERIVED from the two strings rather than
     tracked in a second piece of state that could disagree with them. */
  React.useEffect(() => {
    if (!query) return;
    let live = true;
    void searchProducts(query, 5).then((rows) => {
      if (!live) return;
      setResults(rows);
      setResultsFor(query);
      remember(rows);
    });
    return () => {
      live = false;
    };
  }, [query, remember]);

  const searching = !!query && resultsFor !== query;
  const shown = searching ? [] : results;

  const lines: CartLine[] = React.useMemo(
    () =>
      Object.keys(cart)
        .map((id) => known[id])
        .filter((p): p is Product => !!p)
        .map((p) => ({
          productId: p.id,
          productName: p.name,
          cans: parseInt(cart[p.id], 10) || 0,
          cansPerBox: p.cansPerBox ?? null,
          millilitresPerCan: p.millilitresPerCan ?? null,
          sellingPricePaise: p.sellingPricePaise ?? null,
        })),
    [cart, known],
  );

  /* Credit, schemes and the derived quantities all come back together, from
     the same engines the server runs. Re-read on every change to the cart,
     because the answer to "does this fit" changes with every can. */
  React.useEffect(() => {
    let live = true;
    /* The BILLING party, not the shop. The limit, the outstanding and the
       block belong to whoever is invoiced — assessing against a third-party
       shop reads a blank account and waves everything through. */
    if (!billing) return;
    void assessCart(billing, lines).then((a) => {
      if (live) setAssessment(a);
    });
    return () => {
      live = false;
    };
  }, [billing, lines]);

  if (!c) {
    return (
      <AppFrame title="New order" activeTab={null} onBack={back.go} contentStyle={{ padding: 16 }}>
        <BackLink label={back.label} onPress={back.go} />
        <Card style={{ paddingVertical: 32, alignItems: 'center' }}>
          <T style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Open a customer first</T>
          <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 6 }}>
            An order belongs to a shop. Pick one from Customers.
          </T>
        </Card>
      </AppFrame>
    );
  }

  const dues = c.outstandingPaise / 100;
  const limit = c.creditLimitPaise != null ? c.creditLimitPaise / 100 : null;
  const blocked = !!assessment && !assessment.canOrder;
  const valueUnavailable = assessment?.valueUnavailable ?? true;
  const cartTotal = (assessment?.valuePaise ?? 0) / 100;
  const wouldBe = dues + cartTotal;
  const needsApproval = assessment?.decision === 'needs_approval';

  const inCart = lines.filter((l) => cart[l.productId] != null);
  const blank = inCart.some((l) => !l.cans);
  const canSubmit = inCart.length > 0 && !blank && !blocked && !!billing;

  const frequentOffered = frequent.filter((k) => !cart[k.id]);

  const submit = async () => {
    if (!inCart.length) return notify('Add something first');
    if (blank) return notify('Every line needs a quantity');
    if (!assessment || blocked) return notify(assessment?.blockReason ?? 'This customer cannot be ordered for');
    /* Said while he is standing in the shop rather than by a refusal at sync
       hours later: the arrangement names a distributor who is not his. */
    if (!billing || !biller) {
      return notify(
        `${c.name} is billed to ${billingOptions?.[0]?.name ?? 'somebody'}, who is not on your book. Ask the office to move the account or bill the shop direct.`,
      );
    }

    const { needsApproval: sentForApproval } = await saveOrder({
      customerId: biller.id,
      customerName: biller.name,
      deliveryCustomerId: deliverTo?.id ?? null,
      deliveryCustomerName: deliverTo?.name ?? null,
      userId: boot.session?.user.id ?? '',
      lines: inCart,
      assessment,
    });

    markVisitDone(
      'order',
      plural(inCart.length, 'line') + (valueUnavailable ? '' : ' · ' + inr(cartTotal)),
    );
    set({ cart: {} });
    notify(
      sentForApproval
        ? 'Sent to your manager · queued until approved'
        : 'Order placed · queued, syncs when you have signal',
    );
    back.go();
  };

  return (
    <AppFrame title="New order" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      {/* The owing figure is the BILLER's, so it is named. Reading "nothing
          owing" under a shop's name while the distributor paying for it is
          over their limit is the misreading this line exists to prevent. */}
      <T s="caption">
        {(biller?.name ?? c.name) + ' · ' + (dues ? inr(dues) + ' already owing' : 'nothing owing')}
      </T>

      {/* --------------------------------------------- who pays, who receives
          Drawn ONLY where the two differ or there is a choice to make. On an
          ordinary direct customer both answers are the customer whose screen
          this is, and a row restating that twice is furniture. */}
      {billingOptions && (deliverTo || billingOptions.filter((o) => o.onBook).length > 1) ? (
        <Card style={{ marginTop: 12 }}>
          <SectionLabel style={{ marginBottom: 8 }}>Who pays for this</SectionLabel>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T s="body" style={weight(500)}>
                {'Bill to ' + (biller?.name ?? 'nobody on your book')}
              </T>
              <T s="caption" style={{ color: C.muted }}>
                {deliverTo ? 'Deliver to ' + deliverTo.name : 'Delivered to them'}
              </T>
            </View>
            {billingOptions.filter((o) => o.onBook).length > 1 ? (
              <Pressable
                onPress={() => setPickingBiller((v) => !v)}
                style={{ paddingHorizontal: 10, paddingVertical: 6 }}
              >
                <T s="caption" style={{ color: C.primaryDeep, ...weight(500) }}>
                  {pickingBiller ? 'Done' : 'Change'}
                </T>
              </Pressable>
            ) : null}
          </View>

          {pickingBiller ? (
            <View style={{ marginTop: 10, gap: 6 }}>
              {billingOptions.map((o) => (
                <Pressable
                  key={o.id}
                  disabled={!o.onBook}
                  onPress={() => {
                    setBilling(o.id);
                    setPickingBiller(false);
                  }}
                  style={{
                    borderWidth: 1,
                    borderColor: o.id === billing ? C.primaryDeep : C.hairline,
                    borderRadius: radius.sm,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    opacity: o.onBook ? 1 : 0.5,
                  }}
                >
                  <T s="body">{o.name}</T>
                  <T s="caption" style={{ color: C.muted }}>
                    {!o.onBook
                      ? 'Not on your book — you cannot bill them'
                      : o.id === c.id
                        ? 'Bill the shop direct'
                        : o.isPrimary
                          ? 'Usually bills this shop'
                          : 'Also bills this shop'}
                  </T>
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* The dead end, said plainly. His shop is billed to somebody whose
              account he does not hold, so this order cannot be written — and
              he needs to know that now, not when it is refused at sync. */}
          {!biller ? (
            <T s="caption" style={{ color: C.danger, marginTop: 8 }}>
              {'Billed to ' +
                (billingOptions[0]?.name ?? 'somebody') +
                ', who is not on your book. Ask the office to move the account, or bill the shop direct.'}
            </T>
          ) : null}
        </Card>
      ) : null}

      {/* The one hard block. The sentence is the office's own, not this
          screen's — accounts stopped this customer and said why. */}
      {blocked ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: C.danger,
            backgroundColor: C.dangerBg,
            borderRadius: radius.card,
            paddingHorizontal: 16,
            paddingVertical: 16,
            marginTop: 16,
          }}>
          <T style={[{ fontSize: 15, color: C.danger }, weight(600)]}>No order can be taken here</T>
          <T style={{ fontSize: 13, lineHeight: 19, color: C.ink, marginTop: 6 }}>
            {assessment?.blockReason ?? assessment?.reason ?? ''}
          </T>
        </View>
      ) : null}

      {!blocked ? (
        <>
          {frequentOffered.length > 0 ? (
            <View style={{ marginTop: 16 }}>
              <SectionLabel style={{ marginBottom: 10 }}>What they usually buy</SectionLabel>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginHorizontal: -16 }}
                contentContainerStyle={{ gap: 12, paddingHorizontal: 16, paddingBottom: 4 }}>
                {frequentOffered.map((k) => (
                  <Pressable
                    key={k.id}
                    onPress={() => setQty(k.id, '1')}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      {
                        width: 180,
                        backgroundColor: C.surface,
                        borderWidth: 1,
                        borderColor: C.hairline,
                        borderRadius: radius.xl,
                        padding: 14,
                        boxShadow: shadow.soft,
                      },
                      pressed && { opacity: 0.9 },
                    ]}>
                    <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{k.name}</T>
                    <T s="caption" style={{ marginTop: 2 }}>{k.formulation ?? k.brand ?? ''}</T>
                    <T style={[{ fontSize: 15, color: C.primaryDeep, marginTop: 10 }, weight(500)]}>+ Add</T>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <Input
            value={oQ}
            onChangeText={(v) => set({ oQ: v })}
            placeholder="Search products by name or code"
            style={{ marginTop: 16, borderRadius: radius.md, fontSize: 15 }}
          />

          {query ? (
            <ListCard style={{ marginTop: 10 }}>
              {shown.map((k, i) => {
                const on = !!cart[k.id];
                return (
                  <Pressable
                    key={k.id}
                    onPress={() => {
                      if (!on) setQty(k.id, '1');
                    }}
                    disabled={on}
                    accessibilityRole="button"
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      paddingHorizontal: 16,
                      paddingVertical: 14,
                      borderTopWidth: i ? 1 : 0,
                      borderTopColor: C.wash,
                      backgroundColor: on ? C.primaryTint : C.surface,
                    }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T style={{ fontSize: 15, color: C.ink }}>{k.name}</T>
                      <T s="caption">
                        {[k.formulation ?? k.brand, k.sellingPricePaise != null ? inr(k.sellingPricePaise / 100) + ' / can' : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </T>
                    </View>
                    <T style={[{ fontSize: 15, color: C.primaryDeep }, weight(500)]}>{on ? 'Added' : 'Add'}</T>
                  </Pressable>
                );
              })}
              {/* Three different empty states, and they must never look alike:
                  still looking, nothing matched, nothing offered yet. */}
              {shown.length === 0 ? (
                <View style={{ paddingHorizontal: 16, paddingVertical: 24 }}>
                  <T style={{ fontSize: 15, color: C.muted, textAlign: 'center' }}>
                    {searching ? 'Looking…' : 'Nothing matches. Try the pack size, or the code.'}
                  </T>
                </View>
              ) : null}
            </ListCard>
          ) : null}

          <View style={{ marginTop: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <SectionLabel>On this order</SectionLabel>
              <T s="caption">{inCart.length ? plural(inCart.length, 'product') : 'Nothing added yet'}</T>
            </View>

            {inCart.length === 0 ? (
              <View
                style={{
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: C.border,
                  borderRadius: radius.card,
                  paddingHorizontal: 16,
                  paddingVertical: 24,
                }}>
                <T s="small" style={{ color: C.muted, textAlign: 'center' }}>
                  Tap something they usually buy, or search for it.
                </T>
              </View>
            ) : null}

            <View style={{ gap: 10 }}>
              {inCart.map((line) => {
                const priced = assessment?.lines.find((p) => p.line.productId === line.productId);
                const qty = line.cans;
                /* Cans are what he counts; boxes and litres are derived from
                   the SKU's own packing, never stored. */
                const derived = !qty
                  ? 'Set the quantity'
                  : [
                      plural(qty, 'can'),
                      priced ? plural(Math.ceil(priced.boxes), 'box', 'boxes') : null,
                      priced?.valuePaise != null ? inr(priced.valuePaise / 100) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ');
                return (
                  <Card key={line.productId} padded={false} style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(600)]}>{line.productName}</T>
                        <T s="micro" style={{ marginTop: 2 }}>
                          {priced?.schemeNote ?? known[line.productId]?.formulation ?? ''}
                        </T>
                      </View>
                      <Pressable
                        onPress={() => dropLine(line.productId)}
                        accessibilityRole="button"
                        accessibilityLabel="Remove this line"
                        /* The design draws this at 36, and 36 is under the
                           platform minimum. `hitSlop` keeps the drawing and
                           gives the thumb the area — which matters more here
                           than most: a mis-tap deletes a line off an order. */
                        hitSlop={8}
                        style={{ width: 36, height: 36, marginTop: -6, marginRight: -8, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="close" size={18} color={C.faint} />
                      </Pressable>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 }}>
                      <T style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: C.muted }}>{derived}</T>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          borderWidth: 1,
                          borderColor: qty ? C.primaryEdge : C.danger,
                          borderRadius: radius.md,
                          overflow: 'hidden',
                        }}>
                        <Pressable
                          onPress={() => setQty(line.productId, String(Math.max(0, qty - 1)))}
                          disabled={qty === 0}
                          accessibilityRole="button"
                          accessibilityLabel="One less"
                          style={{ width: 44, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: C.wash }}>
                          <T style={{ fontSize: 20, lineHeight: 20, color: qty > 0 ? C.primaryDeep : C.faint }}>−</T>
                        </Pressable>
                        <TextInput
                          value={cart[line.productId] || ''}
                          onChangeText={(v) => setQty(line.productId, v.replace(/[^0-9]/g, ''))}
                          placeholder="0"
                          placeholderTextColor={C.faint}
                          keyboardType="number-pad"
                          style={[
                            {
                              width: 52,
                              height: 48,
                              borderLeftWidth: 1,
                              borderRightWidth: 1,
                              borderColor: C.hairline,
                              paddingHorizontal: 4,
                              fontSize: 16,
                              textAlign: 'center',
                              color: C.ink,
                              backgroundColor: C.surface,
                            },
                            weight(600),
                            tabular,
                          ]}
                        />
                        <Pressable
                          onPress={() => setQty(line.productId, String(qty + 1))}
                          accessibilityRole="button"
                          accessibilityLabel="One more"
                          style={{ width: 44, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: C.wash }}>
                          <T style={{ fontSize: 20, lineHeight: 20, color: C.primaryDeep }}>+</T>
                        </Pressable>
                      </View>
                    </View>
                  </Card>
                );
              })}
            </View>
          </View>

          <Card style={{ marginTop: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <T style={{ fontSize: 15, color: C.body }}>Order value</T>
              {/* An unvalued order is not an order worth nothing. Until a rate
                  source is confirmed the screen says so rather than showing a
                  confident zero. */}
              <T style={[type.h2, tabular]}>{valueUnavailable ? 'Not known yet' : inr(cartTotal)}</T>
            </View>
            {limit != null ? (
              <>
                <View style={{ height: 8, backgroundColor: C.hairline, borderRadius: 4, marginTop: 12, overflow: 'hidden' }}>
                  <View
                    style={{
                      width: `${Math.min(100, Math.round((wouldBe / limit) * 100))}%`,
                      height: '100%',
                      backgroundColor: needsApproval ? C.danger : C.primary,
                    }}
                  />
                </View>
                <T s="caption" style={{ marginTop: 8 }}>
                  {valueUnavailable
                    ? inr(dues) + ' of ' + inr(limit) + ' credit'
                    : inr(wouldBe) + ' of ' + inr(limit) + ' credit'}
                </T>
              </>
            ) : null}
            {valueUnavailable && inCart.length ? (
              <T s="caption" style={{ marginTop: 6 }}>
                The rate list has not reached this phone, so this order cannot be priced here.
              </T>
            ) : null}
            {needsApproval && assessment ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: C.warnEdge,
                  backgroundColor: C.warnBg,
                  borderRadius: radius.md,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  marginTop: 12,
                }}>
                <T style={{ fontSize: 13, lineHeight: 19, color: C.warnInk }}>{assessment.reason}</T>
              </View>
            ) : null}
          </Card>

          <PrimaryButton
            label={needsApproval ? 'Send for approval' : 'Submit order'}
            onPress={submit}
            disabled={!canSubmit}
            whyDisabled="Add a product and set a quantity on every line first."
            tone={needsApproval ? 'warn' : 'primary'}
            style={{ marginTop: 16 }}
          />
        </>
      ) : null}
      <View style={{ height: 8 }} />
    </AppFrame>
  );
}
