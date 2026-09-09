import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Input, PrimaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, shadow, tabular, weight } from '../src/theme/tokens';
import { inr, isoDate, pretty } from '../src/lib/format';
import { cashInHand, collectPayment, type PaymentMode } from '../src/data/payments';
import { customerBills, type CustomerBill } from '../src/data/customers';
import { copyToClipboard, openWhatsApp, receiptMessage } from '../src/lib/messaging';
import { takePhoto } from '../src/native/capture';
import { useCustomer, useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';

/**
 * Collecting money.
 *
 * The amber card at the top is the reason this screen opens with something
 * other than a form: cash already collected today is the salesman's own
 * liability until it is deposited, and he should be reminded of it before he
 * takes more of it. The deadline on it is the oldest collection's, not an
 * average — a note from Monday that has been in his bag for five days is
 * exactly the one an average hides.
 *
 * What this screen records is money the CUSTOMER handed over. It is not money
 * the business has seen: outstanding does not move until accounts find it in
 * the bank, and nothing here pretends otherwise.
 *
 * WHICH BILLS IT IS AGAINST is asked here, and for a long time it could not be.
 * `collectPayment` has always taken `billRefs`, the server has always read
 * them as `billIds` and allocated in `settle` mode — and no screen ever filled
 * it, so every collection spread OLDEST FIRST however plainly the customer was
 * paying against the invoice in his hand. Naming nothing still spreads oldest
 * first, which is the right default and is now SAID rather than assumed.
 */

const MODES: { label: PaymentMode; glyph: string }[] = [
  { label: 'Cash', glyph: 'money' },
  { label: 'Cheque', glyph: 'note' },
  { label: 'UPI', glyph: 'spark' },
  { label: 'Bank transfer', glyph: 'route' },
];

const CHEQUE_PHOTO_LINE = 'Photograph the cheque before you hand it back.';

export default function PayScreen() {
  const back = useCameFrom('more');
  const c = useCustomer();
  const boot = useBoot();
  const payMode = useStore((s) => s.payMode);
  const payAmt = useStore((s) => s.payAmt);
  const payChq = useStore((s) => s.payChq);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);
  const markVisitDone = useStore((s) => s.markVisitDone);
  const askConfirm = useStore((s) => s.askConfirm);

  const [cash, setCash] = React.useState<{ totalPaise: number; sentence: string; nextDeadline: number | null } | null>(null);
  const [chequePhotoId, setChequePhotoId] = React.useState<string | null>(null);
  const [bills, setBills] = React.useState<CustomerBill[]>([]);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());

  const userId = boot.session?.user.id ?? null;
  const customerId = c?.id ?? null;
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!userId) return;
      void cashInHand(userId).then((p) => {
        if (live) setCash({ totalPaise: p.totalPaise, sentence: p.sentence, nextDeadline: p.nextDeadline });
      });
      /* The office's open bills for this shop. No reset of `picked` here — a
         tick against a bill that is no longer on the list simply does not
         match one, which `chosen` below works out on every render. Clearing
         state in an effect is what the React Compiler rules forbid. */
      if (customerId) void customerBills(customerId).then((b) => live && setBills(b));
      return () => {
        live = false;
      };
    }, [userId, customerId]),
  );

  const amt = parseInt(payAmt || '0', 10);
  const needsCheque = payMode === 'Cheque';

  /*
   * The ticks that still match a bill on the list.
   *
   * Derived rather than stored, so a bill settled since the last pull — the
   * pull replaces this table wholesale — takes its own tick with it instead of
   * being sent to a server that would refuse the whole receipt with
   * `bill_settled`.
   */
  const chosen = bills.filter((b) => picked.has(b.id));
  const namedPaise = chosen.reduce((n, b) => n + (b.balancePaise ?? 0), 0);
  const onAccountPaise = Math.max(0, amt * 100 - namedPaise);
  /* A cheque with no number and no photograph is a promise, not an
     instrument — both are required before this one saves. */
  const payOk = !!payMode && amt > 0 && (!needsCheque || (payChq.trim().length > 0 && !!chequePhotoId));

  const photographCheque = async () => {
    const shot = await takePhoto({ parentType: 'payment', parentId: 'pending', kind: 'cheque_photo' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') notify(shot.reason);
      return;
    }
    setChequePhotoId(shot.mediaId);
  };

  const collect = async () => {
    if (!payMode) return notify('Pick how they are paying');
    if (!amt) return notify('Enter the amount');
    if (needsCheque && !payChq.trim()) return notify('Cheque number is needed');
    if (needsCheque && !chequePhotoId) return notify(CHEQUE_PHOTO_LINE);
    if (!c) return notify('Open a customer first');

    const { receiptRef } = await collectPayment({
      customerId: c.id,
      customerName: c.name,
      userId: boot.session?.user.id ?? '',
      amountPaise: amt * 100,
      mode: payMode as PaymentMode,
      chequeNumber: needsCheque ? payChq.trim() : null,
      chequePhotoId: needsCheque ? chequePhotoId : null,
      /* Named bills, or nothing — in which case the server spreads it oldest
         first, exactly as it always has. */
      billRefs: chosen.length ? chosen.map((b) => b.id) : undefined,
    });

    markVisitDone('payment', payMode + ' · ' + inr(amt));

    /*
     * The receipt is written HERE, on the handset, so it can be shown and sent
     * with no signal at all — the customer has just handed over money and
     * wants something for it now, not when the phone next finds a tower.
     *
     * The reference is marked provisional: the office issues the real receipt
     * number on sync, and printing a temporary one as though it were final is
     * how a payment ends up with two numbers against it.
     */
    const slip = receiptMessage({
      customerName: c.name,
      amountRupees: inr(amt),
      mode: payMode,
      reference: receiptRef,
      confirmed: false,
      collectedBy: boot.session?.user.name ?? 'your salesman',
      when: pretty(isoDate(new Date())),
      chequeNumber: needsCheque ? payChq.trim() : null,
    });

    const phone = c.phone;
    set({ payAmt: '', payChq: '', payMode: null });
    setChequePhotoId(null);
    setPicked(new Set());

    /* Offered, never sent. Nothing goes out on the company's behalf, and the
       payment is not recorded as receipted until a human presses send. */
    askConfirm({
      title: 'Send the receipt?',
      body: phone
        ? `${inr(amt)} recorded for ${c.name}. Your WhatsApp opens with the receipt written — you press send.`
        : `${inr(amt)} recorded for ${c.name}. There is no number on this customer, so the receipt can only be copied.`,
      confirmLabel: phone ? 'Open WhatsApp' : 'Copy the receipt',
      run: async () => {
        const out = phone ? await openWhatsApp(phone, slip) : await copyToClipboard(slip);
        if (out.status !== 'handed_off') notify(out.reason);
      },
    });

    back.go();
  };

  const dues = c ? c.outstandingPaise / 100 : 0;

  return (
    <AppFrame title="Collect payment" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <View
        style={{
          borderWidth: 1,
          borderColor: C.warnEdge,
          backgroundColor: C.warnBg,
          borderRadius: radius.card,
          padding: 16,
        }}>
        <T
          style={[
            { fontSize: 12, lineHeight: 16, letterSpacing: 0.48, textTransform: 'uppercase', color: C.warnInk },
            weight(500),
          ]}>
          Cash on you
        </T>
        <T style={[{ fontSize: 26, lineHeight: 32, letterSpacing: -0.65, color: C.ink, marginTop: 4 }, weight(600), tabular]}>
          {inr((cash?.totalPaise ?? 0) / 100)}
        </T>
        <T style={{ fontSize: 15, color: C.warnInk, marginTop: 2 }}>{cash?.sentence ?? 'No cash on you.'}</T>
      </View>

      <T style={{ fontSize: 15, color: C.body, marginTop: 16 }}>
        {c ? (dues ? 'They owe ' + inr(dues) : 'Nothing outstanding') : 'Open a customer first'}
      </T>

      {/*
        * WHICH BILLS, which is the question the outstanding figure above cannot
        * answer. Drawn only where there are bills to name: an empty list here
        * would read as "this shop has no invoices", which is a different fact
        * from "the office has not sent them down yet".
        */}
      {c && bills.length > 0 ? (
        <View style={{ marginTop: 16 }}>
          <SectionLabel style={{ marginBottom: 10 }}>What is this against</SectionLabel>
          <View style={{ gap: 8 }}>
            {bills.map((b) => {
              const on = picked.has(b.id);
              /*
               * An `unstated` bill is NOT a debt. Its balance is the full
               * amount purely because nobody has recorded anything against it
               * either way, and the office keeps it out of the outstanding
               * figure above — so it says so in words rather than printing a
               * number beside real balances. It can still be named: money
               * recorded against it is what makes somebody speak for it.
               */
              const unstated = b.paymentPosition === 'unstated';
              const overdue = (b.overdueDays ?? 0) > 0;
              return (
                <Pressable
                  key={b.id}
                  onPress={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(b.id)) next.delete(b.id);
                      else next.add(b.id);
                      return next;
                    })
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    borderRadius: radius.xl,
                    borderWidth: 1,
                    borderColor: on ? C.primary : C.hairline,
                    backgroundColor: on ? C.primaryTint : C.surface,
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                  }}>
                  <Icon name={on ? 'check' : 'note'} size={20} color={on ? C.primaryDeep : C.muted} />
                  <View style={{ flex: 1 }}>
                    <T style={[{ fontSize: 15, color: C.ink }, weight(on ? 600 : 500)]}>
                      {b.billNo ?? 'Bill'}
                    </T>
                    <T style={{ fontSize: 13, lineHeight: 18, color: overdue ? C.danger : C.muted, marginTop: 2 }}>
                      {b.billDate ? pretty(b.billDate) : 'No date'}
                      {overdue ? ` · ${b.overdueDays} days overdue` : ''}
                      {b.disputed ? ' · disputed' : ''}
                    </T>
                  </View>
                  {unstated ? (
                    <T style={{ fontSize: 13, color: C.muted, textAlign: 'right', maxWidth: 110 }}>
                      Not stated either way
                    </T>
                  ) : (
                    <T style={[{ fontSize: 15, color: C.ink }, weight(600), tabular]}>
                      {inr((b.balancePaise ?? 0) / 100)}
                    </T>
                  )}
                </Pressable>
              );
            })}
          </View>

          {/* What naming nothing DOES, said rather than assumed — and what a
              remainder becomes, because money on account is a real outcome the
              salesman will be asked about. */}
          <T style={{ fontSize: 13, lineHeight: 18, color: C.muted, marginTop: 10 }}>
            {chosen.length === 0
              ? 'Name none and it goes against their oldest bills first.'
              : onAccountPaise > 0 && amt > 0
                ? `${chosen.length} named · ${inr(onAccountPaise / 100)} more than they cover, which sits on account.`
                : `${chosen.length} named.`}
          </T>
        </View>
      ) : null}

      <View style={{ marginTop: 16 }}>
        <SectionLabel style={{ marginBottom: 10 }}>How are they paying</SectionLabel>
        <View style={{ gap: 12 }}>
          {[MODES.slice(0, 2), MODES.slice(2)].map((row, ri) => (
            <View key={ri} style={{ flexDirection: 'row', gap: 12 }}>
              {row.map((m) => {
                const on = payMode === m.label;
                return (
                  <Pressable
                    key={m.label}
                    onPress={() => set({ payMode: m.label })}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    style={{
                      flex: 1,
                      minHeight: 72,
                      borderRadius: radius.xl,
                      borderWidth: 1,
                      borderColor: on ? C.primary : C.hairline,
                      backgroundColor: on ? C.primaryTint : C.surface,
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      boxShadow: shadow.soft,
                    }}>
                    <Icon name={m.glyph} size={24} color={on ? C.primaryDeep : C.body} />
                    <T style={[{ fontSize: 15, color: on ? C.primaryDeep : C.ink }, weight(on ? 600 : 400)]}>
                      {m.label}
                    </T>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </View>

      <Card style={{ marginTop: 16 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Amount</SectionLabel>
        <Input
          value={payAmt}
          onChangeText={(v) => set({ payAmt: v.replace(/[^0-9]/g, '') })}
          placeholder="42500"
          keyboardType="number-pad"
          style={[{ borderRadius: radius.md, fontSize: 18 }, weight(600), tabular]}
        />
        {needsCheque ? (
          <View style={{ marginTop: 16 }}>
            <SectionLabel style={{ marginBottom: 6 }}>Cheque number and bank</SectionLabel>
            <Input
              value={payChq}
              onChangeText={(v) => set({ payChq: v })}
              placeholder="448210 · HDFC"
              style={{ borderRadius: radius.md, fontSize: 15 }}
            />
            {/* The design's own sentence, made the control that does it — the
                cheque leaves his hand in the next thirty seconds, so the
                instruction and the camera cannot be two separate things. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={CHEQUE_PHOTO_LINE}
              onPress={photographCheque}
              hitSlop={12}>
              <T s="caption" style={{ marginTop: 8, color: chequePhotoId ? C.success : undefined }}>
                {chequePhotoId ? 'Cheque photographed' : CHEQUE_PHOTO_LINE}
              </T>
            </Pressable>
          </View>
        ) : null}
      </Card>

      <PrimaryButton
        label="Collect and make receipt"
        onPress={collect}
        disabled={!payOk}
        whyDisabled="Pick how they are paying and enter the amount first."
        style={{ marginTop: 16 }}
      />
      <View style={{ height: 8 }} />
    </AppFrame>
  );
}
