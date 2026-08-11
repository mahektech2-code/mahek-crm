import React from 'react';
import { View, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Input, ListCard, T } from '../src/components/ui/primitives';
import { color as C, type, weight } from '../src/theme/tokens';
import { inr, plural } from '../src/lib/format';
import { searchProducts } from '../src/data/customers';
import { useStore } from '../src/state/store';

type Row = Awaited<ReturnType<typeof searchProducts>>[number];

/**
 * The rate card, searchable.
 *
 * Stock is on the row rather than behind a tap because the answer to "can I
 * get it this week" changes whether the order is worth taking, and it is asked
 * standing in the shop.
 */

export default function CatalogueScreen() {
  const back = useCameFrom('more');
  const catQ = useStore((s) => s.catQ);
  const set = useStore((s) => s.set);
  const notify = useStore((s) => s.notify);

  const [rows, setRows] = React.useState<Row[]>([]);

  /* Two hundred SKUs is a search box's job, so the matching happens in SQLite
     and reaches the formulation and the brand as well as the name — one liquid
     sells under three of them. */
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      void searchProducts(catQ || '', 200).then((r) => {
        if (live) setRows(r);
      });
      return () => {
        live = false;
      };
    }, [catQ]),
  );

  return (
    <AppFrame title="Product catalogue" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Product catalogue</T>

      <Input
        value={catQ}
        onChangeText={(v) => set({ catQ: v })}
        placeholder="Search a product or pack size"
        style={{ marginTop: 12 }}
      />
      <T s="caption" style={{ marginTop: 8 }}>{plural(rows.length, 'product')}</T>

      {rows.length === 0 ? (
        <Card padded={false} style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }}>
          <T style={{ fontSize: 15, color: C.muted, textAlign: 'center' }}>
            {'Nothing matches that. Try the grade, like "epoxy".'}
          </T>
        </Card>
      ) : (
        <ListCard style={{ marginTop: 12 }}>
          {rows.map((x, i) => (
            <Pressable
              key={x.id}
              onPress={() => notify(x.name + ' · rate card, pack sizes and current stock')}
              accessibilityRole="button"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderTopWidth: i ? 1 : 0,
                borderTopColor: C.wash,
              }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{x.name}</T>
                {/* Depot stock is not in the payload, so the row carries the
                    formulation instead of a confident "In stock" nothing has
                    checked — one liquid sells under three names, and this is
                    what separates two SKUs read out mid-conversation. */}
                <T style={{ fontSize: 13, color: C.muted }}>{x.formulation ?? x.brand ?? ''}</T>
              </View>
              <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
                {(x.sellingPricePaise != null ? inr(x.sellingPricePaise / 100) + ' / ' : '') + (x.packSize ?? '')}
              </T>
            </Pressable>
          ))}
        </ListCard>
      )}
    </AppFrame>
  );
}
