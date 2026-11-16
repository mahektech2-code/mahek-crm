import React from 'react';
import { View } from 'react-native';
import { T } from './primitives';
import { color as C, tabular, weight } from '../../theme/tokens';
import { skusFor } from '../../data/customers';

/**
 * THE SKU CODE, drawn the same way wherever a product appears.
 *
 * `products.sku` is the office's `external_code` — the legacy Product ID, the
 * number a salesman and a shopkeeper both call a product by, and the one thing
 * that tells two pack sizes of one liquid apart at a glance. One component, so
 * the order form, the catalogue, the orders list, samples and the lead screens
 * cannot each draw it a slightly different way.
 */
export function skuText(sku?: string | null): string | null {
  const code = sku?.trim();
  return code ? 'SKU ' + code : null;
}

export function SkuChip({ sku, style }: { sku?: string | null; style?: object }) {
  const text = skuText(sku);
  if (!text) return null;
  /* Version 3 draws the bare code in the chip ("NT-20L"); the word "SKU" is
     what a screen reader says, so the code is never read as a word. */
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={[
        { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, backgroundColor: C.canvas, marginBottom: 3 },
        style,
      ]}>
      <T style={[{ fontSize: 11, lineHeight: 15, color: C.body, letterSpacing: 0.3 }, weight(600), tabular]}>{sku?.trim()}</T>
    </View>
  );
}

/**
 * SKU codes for rows that carry only a product id — an order line, a sample, a
 * lead's chosen product. Read from the catalogue on the phone, so it needs no
 * signal; a product the catalogue no longer carries simply has no code drawn.
 */
export function useSkus(ids: (string | null | undefined)[]): Map<string, string> {
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join('|');
  const [map, setMap] = React.useState<Map<string, string>>(new Map());
  React.useEffect(() => {
    let live = true;
    void skusFor(key ? key.split('|') : []).then((m) => {
      if (live) setMap(m);
    });
    return () => {
      live = false;
    };
  }, [key]);
  return map;
}
