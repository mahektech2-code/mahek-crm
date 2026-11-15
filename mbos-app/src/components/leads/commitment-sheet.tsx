import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { BottomSheet, Calendar } from '../ui/overlays';
import { Swap } from '../ui/motion';
import { PrimaryButton } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { SheetChip, SheetTitle } from './v3-parts';
import { skuText, useSkus } from '../ui/sku';
import { color as C, weight } from '../../theme/tokens';
import { dmy } from '../../lib/format';
import { cleanWhole, parseWhole } from '../../lib/decimal-input';
import { cleanAmount, paiseFromTyped, typedFromPaise } from '../../lib/money-input';
import type { CodedOption } from '../../engines/funnel';

/**
 * §5.5 §9 — WHAT THEY SAID THEY WOULD ORDER.
 *
 * A DAY, A SIZE, AND WHAT IS STOPPING IT. The specification asks for a
 * quantity, a date and a blocker; Mahek's own instruction is that the first two
 * are both mandatory, and that overrules §9 where they differ — "some time next
 * week" is not something a godown can be planned around, and a promise with no
 * size on it cannot be held against the order that eventually answers it.
 *
 * IT SAYS IN WORDS THAT NOTHING MOVES. That sentence is the most important
 * thing on this sheet: a salesman who has just written down a promise will
 * reasonably expect the lead to climb, and it does not — a forecast is not a
 * sale, and the rung above still wants a real order behind it. Said here,
 * before the button, rather than discovered afterwards on a ladder that did not
 * move.
 *
 * The value is OPTIONAL and the quantity is not, which is the opposite way
 * round from what a screen would usually do. `products.priceSource` is still
 * `unset`, so nothing in MahekOne can turn cans into rupees; a figure here is
 * somebody's estimate, and an estimate nobody made must read as absent rather
 * than as a confident zero.
 *
 * Remounted by its `key` rather than reset in an effect, like every other sheet
 * in this app — the React Compiler rules forbid the second and a sheet carrying
 * the last lead's answers is how one shop's promise lands on another's record.
 */
export function CommitmentSheet({
  open,
  today,
  productName,
  productId,
  blockers,
  current,
  onClose,
  onSave,
}: {
  open: boolean;
  today: string;
  /** The SKU qualification named, so the unit on the screen is never ambiguous. */
  productName: string | null;
  /** Its id, so the sheet can print the SKU code beside the name. */
  productId?: string | null;
  blockers: CodedOption[];
  current: { date: string | null; quantityCans: number | null; valuePaise: number | null; blockerCode: string | null };
  onClose: () => void;
  onSave: (c: { date: string; quantityCans: number; valuePaise: number | null; blockerCode: string }) => void;
}) {
  const sku = skuText(useSkus([productId]).get(productId ?? ''));
  const [date, setDate] = React.useState(current.date ?? '');
  const [cans, setCans] = React.useState(current.quantityCans ? String(current.quantityCans) : '');
  /* Rupees on the screen and paise in the store, the one place the two meet —
     the same conversion the prospect form and the new-lead form do. */
  const [rupees, setRupees] = React.useState(current.valuePaise ? typedFromPaise(current.valuePaise) : '');
  /* `no_blocker` is the default and is a real answer: a commitment nobody was
     asked about and one somebody said was clear are different facts, and only
     the second says anybody put the question. */
  const [blocker, setBlocker] = React.useState(current.blockerCode ?? 'no_blocker');
  const [picking, setPicking] = React.useState(false);

  const cansNow = parseWhole(cans) ?? 0;
  const missing = !date
    ? 'Choose the day they will order.'
    : !cansNow
      ? 'Write how many cans. A promise without cans cannot be planned.'
      : undefined;

  const box = { flex: 1, minWidth: 0, minHeight: 64, borderRadius: 18, backgroundColor: C.canvas, paddingHorizontal: 12, paddingVertical: 8 } as const;
  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <SheetTitle
        title="Their promise"
        sub="Only a promise · the stage moves on a real order"
        lead={<Icon name="order" size={22} color={C.ink} strokeWidth={2} />}
      />

      {/* When, how many, what it is worth — three boxes side by side. The
          date box opens into the calendar in place, and the calendar folds
          back once a day is picked. */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Pressable
          onPress={() => setPicking((p) => !p)}
          accessibilityRole="button"
          accessibilityLabel={'When will they order: ' + (date ? dmy(date) : 'choose a day')}
          style={box}>
          <Icon name="cal" size={14} color={C.muted} strokeWidth={2.2} />
          <Text numberOfLines={1} style={[{ fontSize: 16, lineHeight: 22, color: date ? C.ink : C.faint }, weight(800)]}>
            {date ? dmy(date) : 'Day'}
          </Text>
        </Pressable>
        <View style={box}>
          <Text style={[{ fontSize: 11, lineHeight: 15, color: C.muted }, weight(400)]}>cans</Text>
          <TextInput
            value={cans}
            onChangeText={(v) => setCans(cleanWhole(v))}
            keyboardType="number-pad"
            placeholder="40"
            placeholderTextColor={C.faint}
            accessibilityLabel="How many cans. Whole cans only."
            style={[{ fontSize: 16, lineHeight: 22, color: C.ink, padding: 0 }, weight(800)]}
          />
          {cans.includes('.') ? (
            <Text style={[{ fontSize: 11, lineHeight: 15, color: C.danger }, weight(400)]}>Whole cans only.</Text>
          ) : null}
        </View>
        <View style={box}>
          <Text style={[{ fontSize: 11, lineHeight: 15, color: C.muted }, weight(400)]}>₹ if known</Text>
          <TextInput
            value={rupees}
            onChangeText={(v) => setRupees(cleanAmount(v))}
            keyboardType="decimal-pad"
            placeholder="—"
            placeholderTextColor={C.faint}
            accessibilityLabel="Value in rupees, if you know. Leave it empty if you do not know the price. Do not guess a figure."
            style={[{ fontSize: 16, lineHeight: 22, color: C.ink, padding: 0 }, weight(800)]}
          />
        </View>
      </View>
      <Swap id={picking ? 'calendar' : 'none'}>
        {picking ? (
          <View style={{ marginTop: 10 }}>
            <Calendar
              key="commitment-cal"
              selected={date}
              /* A day already gone is not a forecast. Today is allowed: a
                 shopkeeper saying "I will send it this evening" is the
                 ordinary best case and refusing it would send somebody to
                 type tomorrow. */
              disabledReason={(iso) => (iso < today ? 'That day has passed.' : null)}
              onPick={(iso) => {
                setDate(iso);
                setPicking(false);
              }}
            />
          </View>
        ) : (
          <View />
        )}
      </Swap>
      {/* CANS, and the SKU beside them so the unit is never in doubt. A lead
          being asked for a first order has been through qualification, which
          named the product — so there IS a pack size here, which is exactly
          what there was not at capture, where the answer is in litres. */}
      <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }, weight(400)]}>
        {productName
          ? 'Cans of ' + productName + (sku ? ' (' + sku + ')' : '') + '. The app has no prices — leave ₹ empty rather than guess.'
          : 'In cans, the way they will order. No product is set on this lead yet.'}
      </Text>

      <Text style={[{ fontSize: 13, color: C.ink, marginTop: 10 }, weight(700)]}>What stops it today</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {blockers.map((b) => (
          <SheetChip key={b.code} label={b.label} on={blocker === b.code} onPress={() => setBlocker(b.code)} />
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => ({ width: 110, height: 56, borderRadius: 28, backgroundColor: pressed ? C.hairline : C.canvas, alignItems: 'center', justifyContent: 'center' })}>
          <Text style={[{ fontSize: 14, color: C.ink }, weight(700)]}>Cancel</Text>
        </Pressable>
        <PrimaryButton
          label="Save"
          tone="navy"
          disabled={Boolean(missing)}
          whyDisabled={missing}
          onPress={() => {
            if (missing) return;
            onSave({
              date,
              quantityCans: cansNow,
              valuePaise: paiseFromTyped(rupees) || null,
              blockerCode: blocker,
            });
          }}
          style={{ flex: 1, borderRadius: 28 }}
        />
      </View>
    </BottomSheet>
  );
}
