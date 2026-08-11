import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Input, PrimaryButton, SectionLabel, T } from '../src/components/ui/primitives';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, shadow, tabular, weight } from '../src/theme/tokens';
import { inr, isoDate, pretty } from '../src/lib/format';
import { cashInHand, collectPayment, type PaymentMode } from '../src/data/payments';
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

  const userId = boot.session?.user.id ?? null;
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      if (!userId) return;
      void cashInHand(userId).then((p) => {
        if (live) setCash({ totalPaise: p.totalPaise, sentence: p.sentence, nextDeadline: p.nextDeadline });
      });
      return () => {
        live = false;
      };
    }, [userId]),
  );

  const amt = parseInt(payAmt || '0', 10);
  const needsCheque = payMode === 'Cheque';
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
