import React from 'react';
import { View, Pressable, Text, TextInput, type TextProps } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Input } from '../src/components/ui/primitives';
import { Pill } from '../src/components/ui/v3';
import { GLYPH, Glyph, type GlyphShape } from '../src/components/me/kit';
import { Icon } from '../src/components/ui/Icon';
import { Appear, CountUp, FillBar, Presence, animateLayout } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import { isOnline } from '../src/sync/engine';
import { SkuChip } from '../src/components/ui/sku';
import { color as C, tabular, type, weight } from '../src/theme/tokens';
import { inr, inrFromPaise, plural } from '../src/lib/format';
import { skuLines } from '../src/lib/sku-lines';
import { cleanWhole, parseWhole } from '../src/lib/decimal-input';
import {
  billingChoicesFor,
  listCustomersPage,
  productsByIds,
  searchProducts,
  type BillingChoice,
  type Customer,
} from '../src/data/customers';
import { freshSuggestions, rememberedSuggestions, type OrderSuggestions } from '../src/data/order-suggestions';
import {
  assessCart,
  editOrder,
  orderForChange,
  requestOrderChange,
  saveOrder,
  type CartLine,
  type OrderAssessment,
} from '../src/data/orders';
import { lastOrderLines, ratesForTag, type ReorderLine } from '../src/data/pricing';
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

/**
 * How many search results are offered at once.
 *
 * It was five, and five is a SLICE of this catalogue rather than an answer to
 * it: one finished good is several SKUs differing only by pack — "Nano Thinner
 * - 5 Liter (6 Can/Box)", "… (Loose)", "… 20 Liter" — and the search matches
 * the formulation and the brand as well as the name, so "nano" alone matches
 * far more than five. Nothing on the screen said the list was cut, so mid-call
 * he read five rows that did not include the pack the customer asked for and
 * concluded we do not stock it. The line under the list is the other half of
 * the fix: a cap nobody is told about is the same bug at twenty.
 */
const SEARCH_LIMIT = 20;

type Product = {
  id: string;
  name: string;
  /** The SKU code — the legacy Product ID everybody calls it by. */
  sku?: string | null;
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
  /*
   * A LINE ARRIVING OR LEAVING MOVES THE ORDER UNDER IT. Adding a product puts
   * a card into "On this order" and pushes the total down; taking one off
   * pulls everything up. Without the layout animation both happen in a frame,
   * and the thing he was about to tap is somewhere else. The state change is
   * made first-class here so every door — the row's Add, the cross, the
   * stepper going below one, a quantity typed down to nothing — moves the
   * same way.
   */
  const addLine = (id: string) => {
    animateLayout();
    setQty(id, '1');
  };
  const removeLine = (id: string) => {
    animateLayout();
    dropLine(id);
  };
  /* One can more or less is a choice moving one notch, felt as a tick — he is
     counting cans with his thumb while the shopkeeper talks, eyes on the
     shelf. Typing a number does not tick: the keyboard already clicks. */
  const stepQty = (id: string, next: number) => {
    feedback('select');
    if (next < 1) removeLine(id);
    else setQty(id, String(next));
  };
  const notify = useStore((s) => s.notify);
  const markVisitDone = useStore((s) => s.markVisitDone);

  /* Every product this panel has been shown, by id. A cart line whose product
     fell out of the last search still has a name, a pack and a rate. */
  const [known, setKnown] = React.useState<Record<string, Product>>({});
  const [suggested, setSuggested] = React.useState<OrderSuggestions | null>(null);

  /*
   * WHICH SHOP, asked rather than assumed.
   *
   * `custId` is whichever shop was opened last, and the + sheet's "Punch order"
   * opened this form on it without a word — so the order went to the last shop
   * he had looked at, which on one handset was a lead called OM Enterprises
   * every time. Arriving from a shop's own record or from a visit, the shop is
   * the one he is on. Inside a visit he has checked in to, it is that visit's
   * shop. From anywhere else he says which, and the shop is drawn large enough
   * to be noticed and changed.
   */
  const params = useLocalSearchParams<{ from?: string; edit?: string; change?: string }>();
  const arrival = useStore((s) => s.arrival);
  const inVisit = arrival?.checkedInAt != null ? arrival : null;
  /*
   * CHANGING AN ORDER ALREADY TAKEN. `edit` is one accounts have not decided —
   * he rewrites it himself. `change` is one they approved — what he builds here
   * goes to them as a request, with his reason, and the order stays as approved
   * until they answer. Either way the shop is the order's and is not changed.
   */
  const editId = params.edit ?? null;
  const changeId = params.change ?? null;
  const changingId = editId ?? changeId;
  const [changing, setChanging] = React.useState<Awaited<ReturnType<typeof orderForChange>>>(null);
  const [changeNote, setChangeNote] = React.useState('');
  const shopIsGiven = params.from === 'customer' || params.from === 'visit' || !!inVisit || !!changingId;
  const [picking, setPicking] = React.useState(!shopIsGiven);
  React.useEffect(() => {
    if (changingId) return;
    if (inVisit && params.from !== 'customer' && useStore.getState().custId !== inVisit.customerId) {
      set({ custId: inVisit.customerId });
    }
  }, [inVisit, params.from, set, changingId]);
  const [results, setResults] = React.useState<Product[]>([]);
  /** Which query the rows in `results` answer. Anything else is stale. */
  const [resultsFor, setResultsFor] = React.useState<string | null>(null);
  const [assessment, setAssessment] = React.useState<OrderAssessment | null>(null);
  /** `mbos_price_list`, for this customer's own tag. See `data/pricing.ts`. */
  const [listRates, setListRates] = React.useState<Map<string, number>>(new Map());
  const [lastOrder, setLastOrder] = React.useState<ReorderLine[]>([]);

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
  /**
   * The order is being written.
   *
   * `saveOrder` awaits a transaction, a dynamic import and an enqueue before
   * the cart is cleared, and nothing moved `canSubmit` during that window —
   * so a second tap on a slow phone ran the whole handler again. Each call
   * takes a fresh `stamp()` id, so the two payloads differ and the queue's
   * idempotency key cannot dedupe them: the office receives two orders, and
   * the customer is billed for both.
   */
  const [busy, setBusy] = React.useState(false);
  /* The lock itself. `busy` is read from the closure of the render that drew
     the button — the render where it was still false — so a second fast tap
     ran the whole handler again. A ref is set synchronously; `busy` is only
     what the button is drawn from. */
  const busyRef = React.useRef(false);

  const remember = React.useCallback((rows: Product[]) => {
    setKnown((prev) => {
      const next = { ...prev };
      for (const r of rows) next[r.id] = r;
      return next;
    });
  }, []);

  const custId = c?.id ?? null;

  /* The order being changed: its shop, and its lines back in the cart. */
  React.useEffect(() => {
    if (!changingId) return;
    let live = true;
    void orderForChange(changingId).then(async (o) => {
      if (!live || !o) return;
      /* The shop the goods go to — the billing choice below picks the biller. */
      set({ custId: o.deliveryCustomerId ?? o.customerId });
      const found = await productsByIds(o.lines.map((l) => l.productId));
      if (!live) return;
      remember(found);
      set({ cart: Object.fromEntries(o.lines.map((l) => [l.productId, String(l.cans)])) });
      setChanging(o);
    });
    return () => {
      live = false;
    };
  }, [changingId, set, remember]);

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

  /* An order being changed keeps the biller it was taken against. */
  React.useEffect(() => {
    if (changing && billingOptions?.some((o) => o.id === changing.customerId)) setBilling(changing.customerId);
  }, [changing, billingOptions]);

  /** Who is being invoiced. Every credit figure on this screen is theirs. */
  const biller = billingOptions?.find((o) => o.id === billing) ?? null;
  /** Where the goods go, when that is not where the bill goes. */
  const deliverTo = c && billing && billing !== c.id ? c : null;

  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!custId) return;
      /* And whatever is already in the cart. A line is drawn only for a
         product this screen has been shown, and the visit assistant fills the
         cart from a product the salesman named — which may be neither
         frequent nor a starter. Without this the line sat in the cart
         undrawn, counted by nothing on the screen. */
      const inCartIds = Object.keys(useStore.getState().cart);
      /* What was last known first — instant, and all there is with no signal —
         then the office's answer over it. */
      void Promise.all([rememberedSuggestions(custId), productsByIds(inCartIds)]).then(([known, inCart]) => {
        if (!live) return;
        setSuggested(known);
        remember([...known.usual, ...known.starter, ...inCart]);
      });
      void freshSuggestions(custId).then((today) => {
        if (!live || !today) return;
        setSuggested(today);
        remember([...today.usual, ...today.starter]);
      });
      return () => {
        live = false;
      };
    }, [custId, remember]),
  );

  const priceTag = c?.priceTag ?? null;

  React.useEffect(() => {
    let live = true;
    if (!custId) return;
    void Promise.all([ratesForTag(priceTag), lastOrderLines(custId)]).then(([rates, last]) => {
      if (!live) return;
      setListRates(rates);
      setLastOrder(last);
    });
    return () => {
      live = false;
    };
  }, [custId, priceTag]);

  const query = (oQ || '').trim();

  /* The search runs in the database. An empty box is not a search — it is the
     starter list, which is already on screen. Whether the answer on screen is
     the answer to what is typed is DERIVED from the two strings rather than
     tracked in a second piece of state that could disagree with them. */
  React.useEffect(() => {
    if (!query) return;
    let live = true;
    void searchProducts(query, SEARCH_LIMIT).then((rows) => {
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

  if (picking || !c) {
    return (
      <AppFrame
      tone="canvas"
        title="New order"
        activeTab={null}
        onBack={back.go}
        showTitle={false}
        heroTop={<HeadTitle title="New order" sub="Which shop?" />}
        contentStyle={{ paddingHorizontal: 14, paddingTop: 16 }}>
        <BackLink label={back.label} onPress={back.go} />
        <ShopPicker
          current={c}
          onPick={(id) => {
            /* Setting a different shop clears the draft — see `draftMovedShop`. */
            set({ custId: id });
            setPicking(false);
          }}
        />
      </AppFrame>
    );
  }

  /*
   * THE CREDIT ON THIS SCREEN IS THE BILLER'S, and it was the shop's.
   *
   * `assessCart` has always computed the block, the limit and the approval off
   * whoever is INVOICED; the two figures drawn beside them came off
   * `useCustomer()`, which is the shop the salesman is standing in. On an
   * account served through a distributor that put the shop's balance under the
   * distributor's name and drew a bar out of the shop's limit — comfortably
   * half full, over an assessment saying the order needed approval, or reading
   * "nothing owing" over a distributor already past their limit. The figures
   * come out of the assessment now, from the row the verdict was reached on.
   *
   * The id is checked because an assessment for the PREVIOUS biller is still
   * in state for a frame after the choice changes, and one frame of the wrong
   * party's balance is the same lie told faster. Until the answer lands the
   * shop's own figures stand only where the shop IS the biller; otherwise
   * nothing is asserted.
   */
  const credit =
    assessment && assessment.billingCustomerId === billing
      ? { outstandingPaise: assessment.billingOutstandingPaise, creditLimitPaise: assessment.billingCreditLimitPaise }
      : billing === c.id
        ? { outstandingPaise: c.outstandingPaise, creditLimitPaise: c.creditLimitPaise }
        : null;

  const dues = (credit?.outstandingPaise ?? 0) / 100;
  const limit = credit?.creditLimitPaise != null ? credit.creditLimitPaise / 100 : null;
  const blocked = !!assessment && !assessment.canOrder;
  const valueUnavailable = assessment?.valueUnavailable ?? true;
  const cartTotal = (assessment?.valuePaise ?? 0) / 100;
  const wouldBe = dues + cartTotal;
  const needsApproval = assessment?.decision === 'needs_approval';

  const inCart = lines.filter((l) => cart[l.productId] != null);
  const blank = inCart.some((l) => !l.cans);
  const canSubmit = inCart.length > 0 && !blank && !blocked && !!billing;

  const usual = suggested?.usual ?? [];
  const starter = suggested?.starter ?? [];
  const totalCans = inCart.reduce((n, l) => n + l.cans, 0);

  /* This account's own list rate, summed — a SEPARATE figure from "Order
     value" above, which stays tied to products.priceSource and reads "Not
     known yet" until that switch is deliberately flipped. Null the moment any
     line has no rate on this tag: a total that quietly excluded one line
     would look complete and be wrong. */
  const listValuePaise = priceTag && inCart.length && inCart.every((l) => listRates.has(l.productId))
    ? inCart.reduce((sum, l) => sum + l.cans * (listRates.get(l.productId) ?? 0), 0)
    : null;

  const reorder = async () => {
    const found = await productsByIds(lastOrder.map((l) => l.productId));
    if (!found.length) return notify('No product from that order is sold now.', 'error');
    remember(found);
    animateLayout();
    const byId = new Map(lastOrder.map((l) => [l.productId, l.cans]));
    for (const p of found) setQty(p.id, String(Math.max(1, byId.get(p.id) ?? 1)));
    const dropped = lastOrder.length - found.length;
    notify(
      `${plural(found.length, 'line')} from the last order, added.` +
        (dropped ? ` ${plural(dropped, 'line')} not sold now.` : '') +
        ' Check quantities before sending.',
      'warn',
    );
  };

  const submit = async () => {
    /* `whyDisabled` keeps this button pressable so the handler can refuse in
       words, which means the in-flight lock has to be checked here as well as
       drawn on the button. */
    if (busyRef.current) return notify('Still sending the last order…', 'info');
    if (!inCart.length) return notify('Add a product first', 'error');
    if (blank) return notify('Set a quantity on every line', 'error');
    if (!assessment || blocked) return notify(assessment?.blockReason ?? 'You cannot take an order for this customer', 'error');
    /* Said while he is standing in the shop rather than by a refusal at sync
       hours later: the arrangement names a distributor who is not his. */
    if (!billing || !biller) {
      return notify(
        `${c.name} is billed to ${billingOptions?.[0]?.name ?? 'someone'}, who is not in your list. Ask the office to move the account, or bill the shop direct.`,
        'error',
      );
    }

    if (changingId) {
      if (!changing) return notify('Still reading the order…', 'info');
      if (changeId && changeNote.trim().length < 3) return notify('Say why it needs to change. Accounts decide on that.', 'error');
      busyRef.current = true;
      setBusy(true);
      try {
        const r = editId
          ? await editOrder({ orderId: changing.id, lines: inCart, assessment })
          : await requestOrderChange({ orderId: changing.id, lines: inCart, assessment, note: changeNote });
        if (!r.ok) return notify(r.message, 'error');
        set({ cart: {} });
        notify(
          editId
            ? 'Order updated · syncs when you have signal'
            : 'Change sent to accounts · you will see their answer on Your orders',
        );
        back.go();
      } catch {
        notify('That could not be saved on this phone. Nothing was sent. Try again.', 'error');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      return;
    }

    /*
     * THIS VISIT'S ORDER, or somebody else's.
     *
     * The + button opens this form from anywhere, and inside a visit it opened
     * on the visit's shop — but the shop can be changed, and an order for a
     * different shop was still marking the visit's own "order" as done, which
     * let the visit check out claiming an order it never produced. Only an
     * order whose goods or bill are this visit's shop belongs to the visit.
     */
    const forVisit =
      !!inVisit && (c.id === inVisit.customerId || biller.id === inVisit.customerId);

    busyRef.current = true;
    setBusy(true);
    try {
      const { orderId, needsApproval: sentForApproval } = await saveOrder({
        customerId: biller.id,
        customerName: biller.name,
        deliveryCustomerId: deliverTo?.id ?? null,
        deliveryCustomerName: deliverTo?.name ?? null,
        userId: boot.session?.user.id ?? '',
        /* Named from the moment it is taken — see `Arrival.visitId`. */
        visitId: forVisit ? inVisit?.visitId ?? null : null,
        lines: inCart,
        assessment,
      });

      if (forVisit) {
        const linked = useStore.getState().visitLinked;
        set({ visitLinked: { ...linked, orderIds: [...(linked.orderIds ?? []), orderId] } });
        markVisitDone(
          'order',
          plural(inCart.length, 'line') + (valueUnavailable ? '' : ' · ' + inr(cartTotal)),
        );
      }
      set({ cart: {} });
      notify(
        sentForApproval
          ? 'Sent to your manager · waiting for approval'
          : (await isOnline())
            ? 'Order saved · sending to the office now'
            : 'Order saved · will send when you have signal',
      );
      /* Inside a visit the visit carries on; anywhere else the receipt says what the order is now. */
      if (forVisit) back.go();
      else router.replace(`/order-sent?id=${orderId}`);
    } catch {
      /* Said, rather than the button going quiet: a save that threw has
         written nothing, and he is standing in front of the customer. */
      notify('The order could not be saved on this phone. Nothing was sent. Try again.', 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /* The verdict on the credit, said on the dock as a tag. The bar's colour
     stays tied to `needsApproval` — the office's rule — and the tag says what
     the bar shows: past the limit, or inside it. */
  const shownBalance = valueUnavailable ? dues : wouldBe;
  const overLimit = limit != null && shownBalance > limit;
  const owingLine =
    credit === null
      ? 'Checking what they owe…'
      : dues
        ? inr(dues) + (limit != null ? ' of ' + inr(limit) + ' credit' : ' already owing')
        : 'Nothing owing';
  /* The owing figure is the BILLER's, so it is named for a screen reader as
     well as drawn beside the biller. */
  const owingA11y =
    (biller && biller.id !== c.id ? biller.name + ' · ' : '') +
    (credit === null
      ? 'Checking what they owe…'
      : dues
        ? inr(dues) + ' already owing' + (limit != null ? ' of ' + inr(limit) + ' credit' : '')
        : 'Nothing owing');
  const showsBilling = !!billingOptions && (!!deliverTo || billingOptions.length > 1);
  const canChangeShop = !(inVisit || params.from === 'visit' || changingId);
  const title = editId ? 'Edit order' : changeId ? 'Change order' : 'New order';
  const sub = editId
    ? changing?.orderNumber ?? 'Reading the order…'
    : changeId
      ? 'Request · ' + (changing?.orderNumber ?? '')
      : 'From ' + back.label.toLowerCase();
  const submitLabel = busy
    ? 'Sending…'
    : editId
      ? 'Save changes'
      : changeId
        ? 'Send change request to accounts'
        : (needsApproval ? 'Send for approval' : 'Submit order') + ' · ' + c.name;
  const whyOff = busy
    ? 'The last order is still sending.'
    : changeId
      ? 'Off until every line has a quantity · for ' + c.name
      : 'Add a product and set a quantity on every line.';

  /* ------------------------------------------------------------ the dock
     The order's sum, its credit and its one button, pinned to the bottom in
     place of the tab bar — the cart is read top to bottom, and the figure his
     thumb is heading for never moves while he steps cans above it. */
  const dock = (
    <View
      style={{
        backgroundColor: C.navy,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 16,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Tx style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted }}>Order value</Tx>
          {/* An unvalued order is not an order worth nothing. Until a rate
              source is confirmed the screen says so rather than showing a
              confident zero. The total runs to its new figure as cans are
              stepped, so the eye sees the order grow with each tap rather
              than a number replaced. Not from zero — opening the screen is
              not news. */}
          {valueUnavailable ? (
            <Tx style={[{ fontSize: 24, lineHeight: 30, letterSpacing: -0.48, color: '#FFFFFF' }, weight(800)]}>
              Not known yet
            </Tx>
          ) : (
            <CountUp
              value={assessment?.valuePaise ?? 0}
              format={(n) => inrFromPaise(Math.round(n))}
              duration={320}
              style={[{ fontSize: 28, lineHeight: 34, letterSpacing: -0.56, color: '#FFFFFF' }, weight(800), tabular]}
            />
          )}
          {/* A second, narrower figure: this account's own `mbos_price_list`
              rate, summed. It is not the office's order value above — that
              one waits on products.priceSource — but it is real, and it is
              the only value most of this screen will show until that
              switch is flipped. */}
          {listValuePaise != null ? (
            <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Tx style={{ fontSize: 13, lineHeight: 18, color: C.onNavyMuted }}>
                {'List value' + (priceTag ? ' · ' + priceTag : '') + ' · '}
              </Tx>
              <CountUp
                value={listValuePaise}
                format={(n) => inrFromPaise(Math.round(n))}
                duration={320}
                style={[{ fontSize: 13, lineHeight: 18, color: '#FFFFFF' }, weight(700), tabular]}
              />
            </View>
          ) : null}
        </View>
        {limit != null ? (
          <View
            accessible
            accessibilityLabel={overLimit ? 'Over the credit limit' : needsApproval ? 'Needs approval' : 'Inside the credit limit'}
            style={{
              minHeight: 30,
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: 15,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              backgroundColor: overLimit ? 'rgba(255,107,94,0.16)' : needsApproval ? 'rgba(253,243,220,0.14)' : C.limeOnNavy,
            }}>
            <Icon
              name="shield"
              size={14}
              color={overLimit ? '#FF8A7E' : needsApproval ? '#FCE3A6' : C.lime}
              strokeWidth={2.2}
            />
            <Tx style={[{ fontSize: 12, lineHeight: 17, color: overLimit ? '#FF8A7E' : needsApproval ? '#FCE3A6' : C.lime }, weight(700)]}>
              {overLimit ? 'Over limit' : needsApproval ? 'Needs approval' : 'In limit'}
            </Tx>
          </View>
        ) : null}
      </View>

      {limit != null ? (
        <>
          {/* The credit track eases to what the order would bring the balance
              to, so stepping a line up visibly eats into the limit. A row, so
              FillBar's flex takes the width. */}
          <View style={{ flexDirection: 'row', marginTop: 12 }}>
            <FillBar
              pct={limit > 0 ? Math.round((wouldBe / limit) * 100) : 100}
              height={8}
              track="rgba(255,255,255,0.14)"
              fill={needsApproval ? '#FF6B5E' : '#8F6BFF'}
            />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 6 }}>
            <Tx style={[{ flexShrink: 1, fontSize: 12, lineHeight: 16, color: C.onNavyMuted }, tabular]}>
              {inr(shownBalance) + ' of ' + inr(limit) + ' credit'}
            </Tx>
            {inCart.length ? (
              <Tx
                accessibilityLabel={plural(inCart.length, 'product') + ' · ' + plural(totalCans, 'can') + ' · for ' + c.name}
                style={[{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted }, tabular]}>
                {plural(inCart.length, 'product') + ' · ' + plural(totalCans, 'can')}
              </Tx>
            ) : null}
          </View>
        </>
      ) : inCart.length ? (
        <Tx style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted, marginTop: 6 }}>
          {plural(inCart.length, 'product') + ' · ' + plural(totalCans, 'can') + ' · for ' + c.name}
        </Tx>
      ) : null}

      {valueUnavailable && inCart.length ? (
        <Tx style={{ fontSize: 12, lineHeight: 17, color: C.onNavyMuted, marginTop: 8 }}>
          {listValuePaise != null
            ? 'The office has not turned on order value yet. See List value above for what this account pays.'
            : priceTag
              ? `Some lines have no rate for ${priceTag} yet. So no value can be shown.`
              : 'This account has no price list yet. So there are no rates to check.'}
        </Tx>
      ) : null}

      {/* The approval note opens in place as the order crosses the line,
          rather than shoving the button down in the frame his thumb is
          heading for it. */}
      <Presence show={needsApproval && !!assessment}>
        <View style={{ marginTop: 10, backgroundColor: 'rgba(253,243,220,0.12)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 }}>
          <Tx style={{ fontSize: 13, lineHeight: 18, color: '#FCE3A6' }}>{assessment?.reason}</Tx>
        </View>
      </Presence>

      <DockButton
        label={submitLabel}
        onPress={submit}
        disabled={!canSubmit || busy}
        whyDisabled={whyOff}
        warn={needsApproval}
      />
      {!canSubmit || busy ? (
        <Tx style={{ fontSize: 12, lineHeight: 16, color: C.onNavyMuted, textAlign: 'center', marginTop: 6 }}>{whyOff}</Tx>
      ) : null}
    </View>
  );

  return (
    <AppFrame
      tone="canvas"
      title={title}
      activeTab={null}
      onBack={back.go}
      showTitle={false}
      heroTop={<HeadTitle title={title} sub={sub} warn={!!changingId} />}
      footerBg={C.canvas}
      footerInsetBg={C.navy}
      footer={blocked ? undefined : dock}
      contentStyle={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      {changeId ? (
        <View
          style={{
            marginBottom: 10,
            backgroundColor: C.warnBg,
            borderRadius: 20,
            paddingHorizontal: 14,
            paddingVertical: 12,
            flexDirection: 'row',
            gap: 10,
          }}>
          <Icon name="alert" size={18} color={C.warnInk} strokeWidth={2} />
          <Tx
            accessibilityLabel="Accounts already approved this order, so you cannot change it directly. Make the order as it should be and say why. Accounts will accept or decline. You will see their answer in Your orders."
            style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.warnInk }}>
            Already approved, so this goes to accounts as a request with your reason. They accept or decline; the answer
            shows on Your orders.
          </Tx>
        </View>
      ) : null}

      {/* ------------------------------------------ the shop, and who pays
          The owing figure is the BILLER's, so it is named. Reading "nothing
          owing" under a shop's name while the distributor paying for it is
          over their limit is the misreading this card exists to prevent. */}
      <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {changingId ? null : inVisit ? (
              <Pill text="For this visit" bg={C.primaryTint} fg={C.primaryDeep} style={{ alignSelf: 'flex-start', marginBottom: 8 }} />
            ) : (
              <Tx style={[{ fontSize: 11, lineHeight: 15, color: C.muted, marginBottom: 2 }, weight(700)]}>Order for</Tx>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Tx style={[{ flex: 1, fontSize: 18, lineHeight: 24, color: C.ink }, weight(800)]} numberOfLines={2}>
                {c.name}
              </Tx>
              {c.isLead ? <Pill text="Lead" icon="person" bg={C.primaryTint} fg={C.primaryDeep} /> : null}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
              <Glyph shapes={GLYPH.pin} size={13} color={C.muted} strokeWidth={2.2} />
              <Tx style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.muted }} numberOfLines={1}>
                {[c.area, c.city].filter(Boolean).join(', ') || 'No town saved'}
              </Tx>
            </View>
            {showsBilling ? null : <OwingRow text={owingLine} a11y={owingA11y} owes={!!dues} />}
          </View>
          {/* A visit's order belongs to the visit's shop; anywhere else the
              shop can be changed, and changing it clears the draft. */}
          {canChangeShop ? (
            <Pressable
              onPress={() => setPicking(true)}
              accessibilityRole="button"
              accessibilityLabel="Change the shop"
              hitSlop={4}
              style={({ pressed }) => ({
                minHeight: 44,
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: C.primaryTint,
                opacity: pressed ? 0.85 : 1,
              })}>
              <Tx style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(700)]}>Change</Tx>
            </Pressable>
          ) : null}
        </View>

        {editId ? (
          <Tx style={{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 10 }}>
            Accounts have not decided on this order yet. Your changes will replace it.
          </Tx>
        ) : null}

        {/* --------------------------------------------- who pays, who receives
            Drawn ONLY where the two differ or there is somebody else in the
            arrangement. On an ordinary direct customer both answers are the
            customer whose screen this is, and a row restating that twice is
            furniture.

            IT USED TO ASK HOW MANY OF THEM WERE ON HIS BOOK, and that is the
            case it most needed to be drawn for: `billingChoicesFor` always
            appends the shop itself with `onBook: true`, so a third-party shop
            whose only distributor belongs to somebody else fell straight through
            to billing the shop — one on-book option, no card, no chooser, and
            the red sentence inside written for exactly that case can never fire
            because `biller` is never null. He raised an invoice against a shop
            the office says we deliver to and do not bill, with nothing anywhere
            on the screen saying so. */}
        {showsBilling && billingOptions ? (
          <View
            accessibilityLabel="Who gets the bill"
            style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 12, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View accessible accessibilityRole="image" accessibilityLabel="Bill to">
                <Glyph shapes={G.receipt} size={18} color={biller ? C.ink : C.danger} />
              </View>
              <Tx
                accessibilityLabel={'Bill to ' + (biller?.name ?? 'no one in your list')}
                style={[{ flex: 1, fontSize: 14, lineHeight: 19, color: biller ? C.ink : C.danger }, weight(700)]}>
                {biller?.name ?? 'No one in your list'}
                {biller && !deliverTo ? <Tx style={[{ fontSize: 14, lineHeight: 20, color: C.muted }, weight(500)]}> · delivered to them</Tx> : null}
              </Tx>
              {/* Opened on the whole arrangement rather than on the choosable
                  half of it. Where the only other party is off his book there is
                  nothing here to pick, and the list is still the one place the
                  screen says who the office has invoicing this shop. */}
              {billingOptions.length > 1 ? (
                <Pressable
                  onPress={() => setPickingBiller((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={pickingBiller ? 'Done choosing who gets the bill' : 'Change who gets the bill'}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    minHeight: 32,
                    paddingVertical: 4,
                    paddingHorizontal: 12,
                    borderRadius: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pickingBiller ? C.navy : C.primaryTint,
                    opacity: pressed ? 0.85 : 1,
                  })}>
                  <Tx style={[{ fontSize: 12, lineHeight: 17, color: pickingBiller ? '#FFFFFF' : C.primaryDeep }, weight(700)]}>
                    {pickingBiller ? 'Done' : 'Change'}
                  </Tx>
                </Pressable>
              ) : null}
            </View>

            {deliverTo || !biller ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View accessible accessibilityRole="image" accessibilityLabel="Deliver to">
                  <Glyph shapes={G.truck} size={18} color={C.muted} />
                </View>
                <Tx
                  accessibilityLabel={'Deliver to ' + (deliverTo ?? c).name}
                  style={{ flex: 1, fontSize: 13, lineHeight: 18, color: C.muted }}>
                  {(deliverTo ?? c).name}
                </Tx>
              </View>
            ) : null}

            <OwingRow text={owingLine} a11y={owingA11y} owes={!!dues} big />

            {pickingBiller ? (
              <View style={{ marginTop: 2, gap: 6 }}>
                {billingOptions.map((o) => {
                  const on = o.id === billing;
                  return (
                    <Pressable
                      key={o.id}
                      disabled={!o.onBook}
                      onPress={() => {
                        setBilling(o.id);
                        setPickingBiller(false);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on, disabled: !o.onBook }}
                      style={{
                        minHeight: 52,
                        borderRadius: 16,
                        borderWidth: on ? 2 : 1,
                        borderColor: on ? C.primary : C.border,
                        backgroundColor: !o.onBook ? '#F4F6FA' : on ? '#F7F4FF' : C.surface,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                        justifyContent: 'center',
                      }}>
                      <Tx style={[{ fontSize: 14, lineHeight: 19, color: o.onBook ? C.ink : C.faint }, weight(700)]}>
                        {o.name}
                      </Tx>
                      <Tx style={{ fontSize: 12, lineHeight: 16, color: o.onBook ? C.muted : C.faint }}>
                        {!o.onBook
                          ? 'Not in your list. You cannot bill them'
                          : o.id === c.id
                            ? 'Bill the shop direct'
                            : o.isPrimary
                              ? 'Usually bills this shop'
                              : 'Also bills this shop'}
                      </Tx>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {/* A shop the office calls one we deliver to and do not bill, about
                to be billed. It is a legitimate thing to do — a third-party shop
                that starts buying direct is a good day — and it is not a thing
                to do without noticing, so it is said rather than refused. The
                commonest way in is not a deliberate pick at all: his only
                distributor is somebody else's account, and the choice falls
                through to the shop on its own. */}
            {!!c.thirdParty && biller?.id === c.id ? (
              <RedNote>
                {'The office bills this shop to ' +
                  (billingOptions.find((o) => o.id !== c.id)?.name ?? 'someone else') +
                  '. This order bills the shop itself. Ask the office if that is wrong.'}
              </RedNote>
            ) : null}

            {/* The dead end, said plainly. His shop is billed to somebody whose
                account he does not hold, so this order cannot be written — and
                he needs to know that now, not when it is refused at sync. */}
            {!biller ? (
              <RedNote>
                {'Billed to ' +
                  (billingOptions[0]?.name ?? 'someone') +
                  ', who is not in your list. Ask the office to move the account, or bill the shop direct.'}
              </RedNote>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* The one hard block. The sentence is the office's own, not this
          screen's — accounts stopped this customer and said why. Nothing else
          is drawn while it stands: no products, no cart, no button. */}
      {blocked ? (
        <View style={{ marginTop: 10, backgroundColor: C.dangerBg, borderRadius: 22, padding: 18, flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.danger, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="lock" size={20} color="#FFFFFF" strokeWidth={2} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Tx accessibilityRole="header" style={[{ fontSize: 16, lineHeight: 21, color: C.danger }, weight(800)]}>
              You cannot take an order here
            </Tx>
            <Tx style={{ fontSize: 13, lineHeight: 19, color: C.ink, marginTop: 4 }}>
              {assessment?.blockReason ?? assessment?.reason ?? ''}
            </Tx>
          </View>
        </View>
      ) : null}

      {!blocked ? (
        <>
          {/* Only offered on an EMPTY cart — reordering onto lines already
              being built would silently overwrite what he just typed, and
              there is no honest way to merge "put the last order back" with
              "add three more of these" as one tap. */}
          {lastOrder.length > 0 && inCart.length === 0 && !changingId ? (
            <Pressable
              onPress={() => void reorder()}
              accessibilityRole="button"
              accessibilityLabel={'Repeat the last order, ' + plural(lastOrder.length, 'line') + '. Check quantities before sending. Add all'}
              style={({ pressed }) => ({
                marginTop: 10,
                minHeight: 56,
                borderRadius: 18,
                borderWidth: 1.5,
                borderStyle: 'dashed',
                borderColor: '#B9A6FF',
                backgroundColor: '#F7F4FF',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 16,
                paddingVertical: 8,
                opacity: pressed ? 0.85 : 1,
              })}>
              <Icon name="reorder" size={18} color={C.primaryDeep} strokeWidth={2} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Tx style={[{ fontSize: 14, lineHeight: 19, color: C.primaryDeep }, weight(700)]}>Repeat last order</Tx>
                <Tx style={{ marginTop: 2, fontSize: 12, lineHeight: 16, color: C.muted }}>
                  {plural(lastOrder.length, 'line') + ' · check quantities before sending'}
                </Tx>
              </View>
              <Tx style={[{ fontSize: 14, lineHeight: 20, color: C.primaryDeep }, weight(700)]}>Add all</Tx>
            </Pressable>
          ) : null}

          {/* WHAT TO OFFER BEFORE ANYTHING IS TYPED. The office's answer — this
              shop's own history, then the best sellers for a shop with none —
              remembered per shop, so it is there with no signal. Hidden while a
              search is open: one list at a time. */}
          {!query && usual.length > 0 ? (
            <>
              <SectionHead glyph={G.star} glyphFill={C.primary} label="Usual" a11y="What they usually buy" />
              <RowsCard>
                {usual.map((k, i) => (
                  <ProductRow
                    key={k.id}
                    p={k}
                    first={i === 0}
                    on={!!cart[k.id]}
                    qty={cart[k.id]}
                    onQty={(v) => setQty(k.id, v)}
                    onDrop={() => removeLine(k.id)}
                    ordered={{ count: k.orderCount, last: k.lastPurchaseDate ? shortDate(k.lastPurchaseDate) : null }}
                    onAdd={() => addLine(k.id)}
                  />
                ))}
              </RowsCard>
            </>
          ) : null}

          {!query && starter.length > 0 ? (
            <>
              <SectionHead
                glyph={G.trend}
                label={usual.length ? 'Best sellers' : 'Best sellers — nothing on record for this shop yet'}
              />
              <RowsCard>
                {starter.map((k, i) => (
                  <ProductRow
                    key={k.id}
                    p={k}
                    first={i === 0}
                    on={!!cart[k.id]}
                    qty={cart[k.id]}
                    onQty={(v) => setQty(k.id, v)}
                    onDrop={() => removeLine(k.id)}
                    onAdd={() => addLine(k.id)}
                  />
                ))}
              </RowsCard>
            </>
          ) : null}

          {!query && suggested && !usual.length && !starter.length ? (
            <Tx style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 14, paddingHorizontal: 6 }}>
              {suggested.fresh
                ? 'Nothing to suggest for this shop yet — search for the product below.'
                : 'Suggestions arrive the first time this shop is opened with signal. Search below meanwhile.'}
            </Tx>
          ) : null}

          <View
            style={{
              marginTop: 14,
              minHeight: 48,
              borderRadius: 24,
              backgroundColor: C.surface,
              borderWidth: 2,
              borderColor: query ? C.primary : C.surface,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingHorizontal: 14,
            }}>
            <Icon name="search" size={18} color={C.muted} strokeWidth={2} />
            <TextInput
              value={oQ}
              onChangeText={(v) => set({ oQ: v })}
              placeholder="Name, pack size or code"
              placeholderTextColor={C.faint}
              accessibilityLabel="Search product by name, pack size or code"
              returnKeyType="search"
              style={[{ flex: 1, minHeight: 44, fontSize: 15, color: C.ink, paddingVertical: 0 }, weight(400)]}
            />
          </View>

          {query ? (
            <RowsCard style={{ marginTop: 10 }}>
              {shown.map((k, i) => (
                <ProductRow
                  key={k.id}
                  p={k}
                  first={i === 0}
                  on={!!cart[k.id]}
                  qty={cart[k.id]}
                  onQty={(v) => setQty(k.id, v)}
                  onDrop={() => removeLine(k.id)}
                  onAdd={() => addLine(k.id)}
                />
              ))}
              {/* Three different empty states, and they must never look alike:
                  still looking, nothing matched, nothing offered yet. */}
              {shown.length === 0 ? (
                <View style={{ paddingVertical: 22 }}>
                  <Tx style={{ fontSize: 14, lineHeight: 19, color: C.muted, textAlign: 'center' }}>
                    {searching ? 'Searching…' : 'No product found. Try the pack size or the code.'}
                  </Tx>
                </View>
              ) : null}
              {/* A full page is a list that is probably CUT, and a cut list
                  nobody is told about reads as the whole catalogue. */}
              {shown.length >= SEARCH_LIMIT ? (
                <View
                  accessible
                  accessibilityLabel={'Showing the first ' + SEARCH_LIMIT + '. Add the pack size or code to find more.'}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.hairline }}>
                  <Glyph shapes={GLYPH.info} size={14} color={C.muted} />
                  <Tx style={{ flex: 1, fontSize: 12, lineHeight: 16, color: C.muted }}>
                    {'First ' + SEARCH_LIMIT + ' shown. Add pack size or code for more.'}
                  </Tx>
                </View>
              ) : null}
            </RowsCard>
          ) : null}

          <SectionHead
            glyph={G.cart}
            glyphColor={C.ink}
            label="On this order"
            right={
              inCart.length ? (
                <View
                  accessible
                  accessibilityLabel={plural(inCart.length, 'product')}
                  style={{ minHeight: 26, paddingVertical: 2, minWidth: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: C.navy, alignItems: 'center', justifyContent: 'center' }}>
                  <Tx style={[{ fontSize: 12, lineHeight: 17, color: '#FFFFFF' }, weight(700), tabular]}>{inCart.length}</Tx>
                </View>
              ) : (
                <Tx accessibilityLabel="Nothing added yet" style={{ fontSize: 12, lineHeight: 17, color: C.muted }}>Nothing yet</Tx>
              )
            }
          />

          {inCart.length === 0 ? (
            <View
              style={{
                borderWidth: 1.5,
                borderStyle: 'dashed',
                borderColor: '#C7D0DE',
                borderRadius: 20,
                paddingHorizontal: 16,
                paddingVertical: 22,
              }}>
              <Tx
                accessibilityLabel="Tap a product they usually buy, or search for it."
                style={{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center' }}>
                Tap a usual product, or search.
              </Tx>
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            {inCart.map((line) => {
              const priced = assessment?.lines.find((p) => p.line.productId === line.productId);
              const qty = line.cans;
              const listRatePaise = listRates.get(line.productId) ?? null;
              /* Cans are what he counts; boxes and litres are derived from
                 the SKU's own packing, never stored. The list rate is shown
                 only where the CRM's own valuation has nothing to say — two
                 figures on one line would read as a disagreement, not as a
                 fallback.
                 LITRES were what that sentence claimed and the line never
                 printed: `derivedQuantities` returns them and the orders
                 list already renders them, and this is the only screen where
                 the number is still editable. Pack sizes run half a litre to
                 210, so litres beside the cans is the one figure that catches
                 a customer who said "two hundred litres" against a salesman
                 typing 200 into a cans box.
                 And BOXES are dropped where there are none rather than
                 printed as zero: `boxes` is whole boxes, so a loose SKU, a
                 drum and any quantity under one box all derive 0, and "6 cans
                 · 0 boxes" reads as a fault rather than as a pack with no box
                 to count. `Math.ceil` was a no-op on an integer. */
              const counts = [
                plural(qty, 'can'),
                priced?.litres != null ? Math.round(priced.litres) + ' L' : null,
                priced && priced.boxes > 0 ? plural(priced.boxes, 'box', 'boxes') : null,
              ]
                .filter(Boolean)
                .join(' · ');
              const value =
                priced?.valuePaise != null
                  ? inrFromPaise(priced.valuePaise)
                  : listRatePaise != null
                    ? inrFromPaise(qty * listRatePaise)
                    : null;
              const atList = priced?.valuePaise == null && listRatePaise != null;
              /* THE CART LINE LEADS ON THE SKU, as every row on this screen
                 does — see `src/lib/sku-lines.ts`. This is the list a salesman
                 reads back at a counter before saving, and two packs of one
                 liquid have to read as two different lines. A SCHEME NOTE still
                 wins the caption where there is one — it is a live statement
                 about this line's price and outranks a restatement of what the
                 line is. */
              const row = skuLines({ name: line.productName, formulation: known[line.productId]?.formulation });
              return (
                /* The new line settles in where the layout animation has
                   opened room for it — the card arriving, not appearing. */
                <Appear key={line.productId}>
                  <View
                    style={{
                      backgroundColor: C.surface,
                      borderRadius: 20,
                      borderWidth: 2,
                      borderColor: qty ? C.primary : C.danger,
                      paddingTop: 14,
                      paddingBottom: 14,
                      paddingLeft: 16,
                      paddingRight: 12,
                    }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <SkuChip sku={known[line.productId]?.sku} />
                        <Tx style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>{row.lead}</Tx>
                        {priced?.schemeNote ? (
                          <Pill
                            text={priced.schemeNote}
                            bg={C.successBg}
                            fg={C.success}
                            style={{ alignSelf: 'flex-start', marginTop: 6 }}
                          />
                        ) : row.detail ? (
                          <Tx style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 2 }}>{row.detail}</Tx>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => removeLine(line.productId)}
                        accessibilityRole="button"
                        accessibilityLabel="Remove this line"
                        /* A mis-tap deletes a line off an order, so the drawing
                           is 40 and the thumb gets 48. */
                        hitSlop={4}
                        style={({ pressed }) => ({
                          width: 40,
                          height: 40,
                          borderRadius: 20,
                          backgroundColor: C.canvas,
                          alignItems: 'center',
                          justifyContent: 'center',
                          opacity: pressed ? 0.8 : 1,
                        })}>
                        <Icon name="close" size={16} color={C.muted} strokeWidth={2.2} />
                      </Pressable>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
                      {!qty ? (
                        <Tx style={[{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, color: C.danger }, weight(700)]}>
                          Set the quantity
                        </Tx>
                      ) : (
                        <Tx
                          accessibilityLabel={counts + (value ? ' · ' + value + (atList ? ' at list rate' : '') : '')}
                          style={[{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 18, color: C.muted }, weight(600)]}>
                          {counts}
                          {value ? (
                            <>
                              {' · '}
                              <Tx style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(800), tabular]}>{value}</Tx>
                              {atList ? ' at list rate' : ''}
                            </>
                          ) : null}
                        </Tx>
                      )}
                      <Stepper
                        size={44}
                        value={cart[line.productId] || ''}
                        n={qty}
                        inputLabel={'Cans of ' + line.productName}
                        /* A line is never at nought: one less than one takes it
                           off the order, the same as the cross above it. */
                        minusLabel={qty <= 1 ? 'Take off the order' : 'One less'}
                        onMinus={() => stepQty(line.productId, qty - 1)}
                        onPlus={() => stepQty(line.productId, qty + 1)}
                        onChangeText={(v) => setQty(line.productId, cleanWhole(v))}
                        /* Empty is allowed while he types a new number; left at
                           nought or empty, the line comes off the order. A
                           point typed into it stays as "1." until here, so
                           "1.5" never runs together into 15 cans. */
                        onEndEditing={() => {
                          const n = parseWhole(useStore.getState().cart[line.productId] ?? '') ?? 0;
                          if (!(n > 0)) removeLine(line.productId);
                          else setQty(line.productId, String(n));
                        }}
                      />
                    </View>
                  </View>
                </Appear>
              );
            })}
          </View>

          {changeId ? (
            <>
              <SectionHead glyph={G.note} label="Why it needs to change" />
              <Input
                value={changeNote}
                onChangeText={setChangeNote}
                placeholder="Shop wants 10 more cans of the 20 L — rang this morning"
                multiline
                style={{ minHeight: 84, textAlignVertical: 'top', borderRadius: 20, borderWidth: 0, fontSize: 15 }}
              />
            </>
          ) : null}
        </>
      ) : null}
      <View style={{ height: 8 }} />
    </AppFrame>
  );
}

/* ------------------------------------------------------------------ parts */

/** Body text that also carries the accessibility props `T` does not take. */
function Tx({ style, ...rest }: TextProps) {
  return <Text {...rest} style={[type.body, style]} />;
}

/** The glyphs this screen draws that the shared icon set does not carry. */
const G = {
  receipt: [{ p: 'M6 3h12v18l-3-2-3 2-3-2-3 2z' }, { p: 'M9 8h6M9 12h6' }],
  truck: [{ p: 'M3 6h11v10H3zM14 10h4l3 3v3h-7' }, { c: [7, 18, 2] }, { c: [17, 18, 2] }],
  star: [{ p: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z' }],
  trend: [{ p: 'M4 18l6-6 4 4 6-8' }],
  cart: [{ p: 'M4 5h2l2 11h10l2-8H7' }, { c: [10, 20, 1] }, { c: [17, 20, 1] }],
  note: [{ p: 'M5 4h14v16H5z' }, { p: 'M8 9h8M8 13h8M8 17h5' }],
  repeat: [{ p: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6' }],
} satisfies Record<string, GlyphShape[]>;

/** The hero's title row: the screen's name and where it came from. */
function HeadTitle({ title, sub, warn = false }: { title: string; sub: string; warn?: boolean }) {
  return (
    <View>
      <Tx accessibilityRole="header" numberOfLines={1} style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
        {title}
      </Tx>
      {sub ? (
        <Tx numberOfLines={1} style={[{ fontSize: 12, lineHeight: 16, color: warn ? C.warnInk : C.muted }, weight(warn ? 700 : 400)]}>
          {sub}
        </Tx>
      ) : null}
    </View>
  );
}

/** A 15/800 heading above a group, with its glyph and anything on the right. */
function SectionHead({
  glyph,
  glyphColor = C.primary,
  glyphFill,
  label,
  a11y,
  right,
}: {
  glyph: GlyphShape[];
  glyphColor?: string;
  glyphFill?: string;
  label: string;
  a11y?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 10, paddingHorizontal: 6 }}>
      <Glyph shapes={glyph} size={16} color={glyphColor} fill={glyphFill} strokeWidth={glyphFill ? 1 : 2.2} />
      <Tx
        accessibilityRole="header"
        accessibilityLabel={a11y}
        style={[{ flex: 1, fontSize: 15, lineHeight: 20, color: C.ink }, weight(800)]}>
        {label}
      </Tx>
      {right}
    </View>
  );
}

/** The white card a list of products sits in. */
function RowsCard({ children, style }: { children: React.ReactNode; style?: object }) {
  return (
    <View style={[{ backgroundColor: C.surface, borderRadius: 22, paddingTop: 4, paddingBottom: 4, paddingLeft: 16, paddingRight: 12 }, style]}>
      {children}
    </View>
  );
}

/** What the biller owes, with the card icon — red where there is a balance. */
function OwingRow({ text, a11y, owes, big = false }: { text: string; a11y: string; owes: boolean; big?: boolean }) {
  return (
    <View accessible accessibilityLabel={a11y} style={{ flexDirection: 'row', alignItems: 'center', gap: big ? 10 : 5, marginTop: big ? 0 : 4 }}>
      <Glyph shapes={GLYPH.wallet} size={big ? 18 : 13} color={owes ? C.danger : C.muted} strokeWidth={big ? 2 : 2.2} />
      <Tx style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: owes ? C.ink : C.muted }, weight(owes ? 700 : 400)]}>{text}</Tx>
    </View>
  );
}

/** A red box with a sentence the salesman has to read before sending. */
function RedNote({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: C.dangerBg, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 }}>
      <Tx style={{ fontSize: 12, lineHeight: 17, color: C.danger }}>{children}</Tx>
    </View>
  );
}

/** The round − · count · + the cans are counted on. */
function Stepper({
  size,
  value,
  n,
  inputLabel,
  minusLabel,
  onMinus,
  onPlus,
  onChangeText,
  onEndEditing,
}: {
  size: 40 | 44;
  value: string;
  n: number;
  inputLabel: string;
  minusLabel: string;
  onMinus: () => void;
  onPlus: () => void;
  onChangeText: (v: string) => void;
  onEndEditing: () => void;
}) {
  const round = { width: size, height: size, borderRadius: size / 2, alignItems: 'center' as const, justifyContent: 'center' as const };
  const glyph = [{ fontSize: size === 44 ? 20 : 18, lineHeight: size === 44 ? 22 : 20 }, weight(700)];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
      <Pressable
        onPress={onMinus}
        accessibilityRole="button"
        accessibilityLabel={minusLabel}
        /* It sits flush against a text field, so a thumb that misses would
           open a keyboard over the line he was reading: the drawing stays,
           the thumb gets the area. */
        hitSlop={4}
        style={({ pressed }) => [round, { backgroundColor: C.canvas, opacity: pressed ? 0.8 : 1 }]}>
        <Tx style={[glyph, { color: C.ink }]}>−</Tx>
      </Pressable>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onEndEditing={onEndEditing}
        placeholder="0"
        placeholderTextColor={C.faint}
        keyboardType="number-pad"
        accessibilityLabel={inputLabel}
        accessibilityValue={{ text: n ? plural(n, 'can') : 'none' }}
        style={[
          { width: size === 44 ? 42 : 36, height: size, fontSize: size === 44 ? 18 : 17, textAlign: 'center', color: C.ink, paddingHorizontal: 0, paddingVertical: 0 },
          weight(800),
          tabular,
        ]}
      />
      <Pressable
        onPress={onPlus}
        accessibilityRole="button"
        accessibilityLabel="One more"
        hitSlop={4}
        style={({ pressed }) => [round, { backgroundColor: C.primary, opacity: pressed ? 0.85 : 1 }]}>
        <Tx style={[glyph, { color: '#FFFFFF' }]}>+</Tx>
      </Pressable>
    </View>
  );
}

/**
 * The dock's one button. Lime, or amber where the order goes for approval;
 * off it stays pressable while there is a reason, so the handler refuses in
 * words — see `submit` — exactly as `PrimaryButton`'s `whyDisabled` does.
 */
function DockButton({
  label,
  onPress,
  disabled,
  whyDisabled,
  warn,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  whyDisabled: string;
  warn: boolean;
}) {
  const bg = disabled ? 'rgba(198,255,52,0.35)' : warn ? C.warnBg : C.lime;
  const fg = disabled ? C.navy : warn ? C.warnInk : C.navy;
  return (
    <Pressable
      onPress={() => {
        if (disabled) feedback('warning');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      accessibilityHint={disabled ? whyDisabled : undefined}
      style={({ pressed }) => ({
        marginTop: 14,
        minHeight: 56,
        paddingVertical: 8,
        borderRadius: 28,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 18,
        opacity: pressed && !disabled ? 0.88 : 1,
      })}>
      <Tx numberOfLines={1} style={[{ fontSize: 17, lineHeight: 22, color: fg }, weight(700)]}>
        {label}
      </Tx>
    </Pressable>
  );
}

/** "12 Sep" from an ISO date — a last purchase reads as a day, not a timestamp. */
function shortDate(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/** One product to add: the SKU, the liquid, the pack, and one tap. */
function ProductRow({
  p,
  on,
  first,
  ordered,
  qty,
  onAdd,
  onQty,
  onDrop,
}: {
  p: Product;
  on: boolean;
  first: boolean;
  /** How often this shop has ordered it, and when last. */
  ordered?: { count: number; last: string | null };
  /** What is on the order for it, as typed. Drawn as a stepper once added. */
  qty?: string;
  onAdd: () => void;
  onQty?: (v: string) => void;
  onDrop?: () => void;
}) {
  const n = parseInt(qty ?? '', 10) || 0;
  const row = skuLines({ name: p.name, formulation: p.formulation ?? p.brand });
  const orderedText = ordered ? ordered.count + '×' + (ordered.last ? ' · ' + ordered.last : '') : null;
  const orderedA11y = ordered ? 'Ordered ' + plural(ordered.count, 'time') + (ordered.last ? ' · last ' + ordered.last : '') : null;
  const facts = [row.detail, p.sellingPricePaise != null ? inrFromPaise(p.sellingPricePaise) + '/can' : null].filter(
    (x): x is string => !!x,
  );
  return (
    <Pressable
      onPress={() => {
        if (!on) onAdd();
      }}
      disabled={on}
      accessibilityRole="button"
      accessibilityLabel={(on ? 'Added: ' : 'Add ') + p.name + (orderedA11y ? '. ' + orderedA11y : '')}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: C.hairline,
        opacity: pressed ? 0.85 : 1,
      })}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <SkuChip sku={p.sku} />
        <Tx style={[{ fontSize: 14, lineHeight: 19, color: C.ink }, weight(700)]}>{row.lead}</Tx>
        {facts.length || orderedText ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, marginTop: 2 }}>
            {facts.length ? (
              <Tx style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{facts.join(' · ')}</Tx>
            ) : null}
            {orderedText ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Glyph shapes={G.repeat} size={12} color={C.muted} strokeWidth={2.4} />
                <Tx style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{orderedText}</Tx>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      {/* THE QUANTITY ON THE ROW, once it is on the order — the CRM's order
          form takes it on the product card itself, and sending him down to
          the cart to say how many is a scroll per product. The cart below
          stays the place to read the whole order back. */}
      {on && onQty ? (
        <Stepper
          size={40}
          value={qty ?? ''}
          n={n}
          inputLabel={'Cans of ' + p.name}
          minusLabel={n <= 1 ? 'Take it off the order' : 'One less'}
          onMinus={() => {
            feedback('select');
            if (n <= 1) onDrop?.();
            else onQty(String(n - 1));
          }}
          onPlus={() => {
            feedback('select');
            onQty(String(n + 1));
          }}
          onChangeText={(v) => onQty(cleanWhole(v))}
          onEndEditing={() => {
            const whole = parseWhole(qty ?? '');
            if (whole && qty !== String(whole)) onQty(String(whole));
          }}
        />
      ) : on ? (
        <Tx style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(700)]}>✓ Added</Tx>
      ) : (
        <View
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
          <Tx style={[{ fontSize: 20, lineHeight: 22, color: C.primaryDeep }, weight(700)]}>+</Tx>
        </View>
      )}
    </Pressable>
  );
}

/**
 * WHICH SHOP THIS ORDER IS FOR, asked when nothing on the way here said.
 * Searches his own book on the phone — no signal needed — by name, town or
 * number, and puts the shop he last opened first, because that is usually the
 * one he means and is never assumed.
 */
function ShopPicker({ current, onPick }: { current: Customer | null; onPick: (id: string) => void }) {
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<Customer[]>([]);
  const [total, setTotal] = React.useState<number | null>(null);

  React.useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void listCustomersPage({ query: q.trim(), limit: 30 }).then((page) => {
        if (!live) return;
        setRows(page.rows);
        setTotal(page.total);
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const list = !q.trim() && current ? [current, ...rows.filter((r) => r.id !== current.id)] : rows;

  return (
    <>
      <View
        style={{
          minHeight: 48,
          borderRadius: 24,
          backgroundColor: C.surface,
          borderWidth: 2,
          borderColor: C.primary,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 14,
        }}>
        <Icon name="search" size={18} color={C.muted} strokeWidth={2} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Name, town or mobile"
          placeholderTextColor={C.faint}
          accessibilityLabel="Which shop is this order for? Shop name, town or mobile"
          accessibilityHint="Search your book by name, town or mobile."
          autoFocus
          style={[{ flex: 1, minHeight: 44, fontSize: 15, color: C.ink, paddingVertical: 0 }, weight(400)]}
        />
      </View>
      <View style={{ marginTop: 12, backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16 }}>
        {list.map((r, i) => {
          const last = !q.trim() && current && r.id === current.id;
          return (
            <Pressable
              key={r.id}
              onPress={() => onPick(r.id)}
              accessibilityRole="button"
              accessibilityLabel={r.name + (r.isLead ? ', lead' : '') + (last ? ', last opened' : '')}
              style={({ pressed }) => ({
                minHeight: 56,
                paddingVertical: 12,
                borderTopWidth: i ? 1 : 0,
                borderTopColor: C.hairline,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                opacity: pressed ? 0.8 : 1,
              })}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Tx style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]} numberOfLines={1}>
                  {r.name}
                </Tx>
                <Tx style={{ fontSize: 12, lineHeight: 16, color: C.muted }} numberOfLines={1}>
                  {[[r.area, r.city].filter(Boolean).join(', '), r.phone].filter(Boolean).join(' · ') || 'No town saved'}
                </Tx>
              </View>
              {r.isLead ? (
                <View accessible accessibilityRole="image" accessibilityLabel="Lead">
                  <Glyph shapes={GLYPH.person} size={16} color={C.primaryDeep} strokeWidth={2.4} />
                </View>
              ) : null}
              {last ? <Pill text="Last opened" bg={C.primaryTint} fg={C.primaryDeep} /> : null}
            </Pressable>
          );
        })}
        {list.length === 0 ? (
          <View style={{ paddingVertical: 24 }}>
            <Tx style={{ fontSize: 14, lineHeight: 19, color: C.muted, textAlign: 'center' }}>
              {total === null ? 'Looking…' : 'No shop on your book matches that.'}
            </Tx>
          </View>
        ) : null}
      </View>
      {total != null && total > list.length && !q.trim() ? (
        <Tx style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 10, paddingHorizontal: 6 }}>
          {list.length + ' of ' + total + ' — search to narrow.'}
        </Tx>
      ) : null}
    </>
  );
}
