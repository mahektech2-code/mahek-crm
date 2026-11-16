import React from 'react';
import { ActivityIndicator, View, FlatList, Text } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useFocusEffect } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { T } from '../src/components/ui/primitives';
import { SearchBox } from '../src/components/ui/book-controls';
import { color as C, weight } from '../src/theme/tokens';
import { inrFromPaise, plural } from '../src/lib/format';
import { searchProducts } from '../src/data/customers';
import { useStore } from '../src/state/store';
import { SkuChip } from '../src/components/ui/sku';
import { skuLines } from '../src/lib/sku-lines';
import { Stagger } from '../src/components/ui/motion';
import { STAGGER_CAP } from '../src/components/ui/route-motion';

type Row = Awaited<ReturnType<typeof searchProducts>>[number];

/** How many rows the screen draws; past this the count says it is a slice. */
const CAP = 200;

/**
 * The rate card, searchable.
 *
 * IT IS A `FlatList`, for the reason the book's own list is one: the screen
 * opens with an empty query, `searchProducts` answers with the whole catalogue,
 * and `rows.map()` inside the frame's `ScrollView` mounted every one of those
 * two hundred rows on the JS thread before the first paint. He opens this to
 * answer "do we stock that" with a customer waiting, and it took a visible beat
 * to appear and stuttered as he scrolled.
 *
 * Stock is NOT on the row, though the screen once promised it: nothing in
 * MahekOne tracks depot stock, and the product master carries no prices either
 * — `products.priceSource` is unset and `canValueOrders()` answers no. What the
 * row carries is what is real: the name, the formulation, the packing and the
 * rate where one exists.
 */

/** How long a typed word waits before it becomes a query. */
const SEARCH_PAUSE_MS = 250;

/** The hairline between two rows, as `ItemSeparatorComponent`. */
function RowLine() {
  return <View style={{ height: 1, backgroundColor: C.hairline }} />;
}

/** The little box glyph V3 draws before "per box". */
function BoxGlyph() {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" accessibilityLabel="per box">
      <Path d="M3 7l9-4 9 4v10l-9 4-9-4z" stroke={C.muted} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

export default function CatalogueScreen() {
  const back = useCameFrom('more');
  const catQ = useStore((s) => s.catQ);
  const set = useStore((s) => s.set);

  const [rows, setRows] = React.useState<Row[]>([]);
  const [more, setMore] = React.useState(false);
  /*
   * READING, COULD NOT READ, AND NOTHING THERE are three different facts, and
   * this screen drew the third for all three. `rows` starts empty, so a
   * handset whose products table has never synced opened the catalogue with a
   * blank search box and read "Nothing matches that" — advice about a query he
   * never made, for a catalogue that never arrived. He retypes instead of
   * checking sync, which is the exact confusion the rest of this app takes
   * trouble to avoid.
   */
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  /*
   * WHAT HE HAS TYPED AND WHAT HAS BEEN ASKED are two different things. The
   * query went into the store on every keystroke and the effect below re-ran
   * per character, each time a `LIKE '%…%'` over the whole product table that
   * no index can serve. The pause turns a word into one query rather than one
   * query per letter.
   */
  const [typed, setTyped] = React.useState(catQ);
  React.useEffect(() => {
    if (typed === catQ) return;
    const t = setTimeout(() => set({ catQ: typed }), SEARCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [typed, catQ, set]);

  /* Two hundred SKUs is a search box's job, so the matching happens in SQLite
     and reaches the formulation and the brand as well as the name — one liquid
     sells under three of them. */
  useFocusEffect(
    React.useCallback(() => {
      let live = true;
      /* One past the cap, so the count can say when it is a slice. */
      void searchProducts(catQ || '', CAP + 1)
        .then((r) => {
          if (!live) return;
          setMore(r.length > CAP);
          setRows(r.slice(0, CAP));
          setFailed(false);
          setLoaded(true);
        })
        .catch(() => {
          if (!live) return;
          setFailed(true);
          setLoaded(true);
        });
      return () => {
        live = false;
      };
    }, [catQ]),
  );

  const asked = catQ.trim();

  /* Only the rows the first paint shows cascade in. A FlatList mounts the rest
     as they scroll into view, and a row that fades in under a moving thumb
     reads as the list lagging rather than arriving. */
  const renderRow = ({ item, index }: { item: Row; index: number }) =>
    index < STAGGER_CAP ? <Stagger index={index}>{row(item)}</Stagger> : row(item);

  const row = (x: Row) => {
    const lines = skuLines({ name: x.name, formulation: x.formulation ?? x.brand });
    const price = x.sellingPricePaise != null ? inrFromPaise(x.sellingPricePaise) : null;
    return (
      /* NOT PRESSABLE. Every row used to be a button whose whole effect was a
         2.4-second toast at the far end of the screen, `pointerEvents="none"`,
         restating four things already printed on the row — so it read as a
         product detail he could open, and what he got vanished before he had
         read it out. The one fact the toast carried that the row did not was
         cans per box, which is on the subtitle now. */
      <View
        accessible
        accessibilityLabel={[
          lines.lead,
          lines.detail,
          x.cansPerBox ? x.cansPerBox + ' per box' : null,
          (price ? price + ' / ' : '') + (x.packSize ?? ''),
        ]
          .filter(Boolean)
          .join(', ')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* THE SKU LEADS, the same rule as the order form's rows —
              `src/lib/sku-lines.ts`. Depot stock is still not in the payload,
              so what the second line carries is the formulation and the packing
              rather than a confident "In stock" nothing has checked. */}
          <SkuChip sku={x.sku} style={{ borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginBottom: 4 }} />
          <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>{lines.lead}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {lines.detail ? <T style={{ flexShrink: 1, fontSize: 12, color: C.muted }}>{lines.detail + (x.cansPerBox ? ' ·' : '')}</T> : null}
            {x.cansPerBox ? (
              <>
                <BoxGlyph />
                <T style={{ flexShrink: 1, fontSize: 12, color: C.muted }}>{String(x.cansPerBox)}</T>
              </>
            ) : null}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {/* The rate where one exists, the pack size under it; no rate is the
              pack size alone rather than a confident ₹0. */}
          {price ? <T style={[{ fontSize: 16, color: C.ink }, weight(800)]}>{price}</T> : null}
          {x.packSize ? <T style={{ marginTop: 4, fontSize: 12, color: C.muted }}>{x.packSize}</T> : null}
        </View>
      </View>
    );
  };

  /* Nothing terminal until the read has answered, and a catalogue that never
     arrived is a different sentence from a word that matched nothing. */
  const blank = !loaded ? (
    <Line spin>Loading products…</Line>
  ) : failed ? (
    <Line tone="danger" a11y="Could not load products. Go back and open it again. If this keeps happening, tell the office.">
      {'Could not load. Open again; tell the office if it repeats.'}
    </Line>
  ) : asked ? (
    <Line>{'No product found. Try a type, like "epoxy".'}</Line>
  ) : (
    <Line
      cloud
      a11y="Products have not come to this phone yet. They come with the next office update. Wait until you have signal.">
      {'Not on this phone yet. Comes with the next office update; wait for signal.'}
    </Line>
  );

  const h = HERO.lavender;
  return (
    <AppFrame
      title="Product catalogue"
      activeTab={null}
      onBack={back.go}
      scroll={false}
      showTitle={false}
      hero={
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 16 }}>
            <Text
              accessibilityRole="header"
              accessibilityLabel="Product catalogue"
              style={[{ flex: 1, fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: h.ink }, weight(800)]}>
              Catalogue
            </Text>
            {/* The count is a count of what came back. Silent until the read has
                answered, because "0 products" about a query still running is the
                same false verdict in a shorter sentence. */}
            {loaded && !failed ? (
              <Text
                accessibilityLabel={more ? 'Showing the first ' + CAP + '. Search to find the rest.' : undefined}
                style={[{ fontSize: 13, lineHeight: 18, color: h.muted }, weight(700)]}>
                {more ? 'First ' + CAP + ' · search for the rest' : plural(rows.length, 'product')}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', marginTop: 12 }}>
            <SearchBox
              value={typed}
              onChange={setTyped}
              onClear={() => setTyped('')}
              placeholder="Product, pack size or SKU code"
            />
          </View>
        </View>
      }
      contentStyle={{ padding: 14, paddingBottom: 24 }}>
      {rows.length === 0 ? (
        blank
      ) : (
        <View style={{ flex: 1, backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 16, overflow: 'hidden' }}>
          <FlatList
            data={rows}
            keyExtractor={(x) => x.id}
            renderItem={renderRow}
            ItemSeparatorComponent={RowLine}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingVertical: 4 }}
          />
        </View>
      )}
    </AppFrame>
  );
}

/** One sentence in a card — the shape all four blank states share. */
function Line({
  children,
  tone,
  spin = false,
  cloud = false,
  a11y,
}: {
  children: React.ReactNode;
  tone?: 'danger';
  spin?: boolean;
  cloud?: boolean;
  a11y?: string;
}) {
  const danger = tone === 'danger';
  return (
    <View
      accessible
      accessibilityLabel={a11y}
      style={{
        backgroundColor: danger ? C.dangerBg : C.surface,
        borderRadius: 16,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}>
      {spin ? <ActivityIndicator size="small" color={C.primary} /> : null}
      {cloud ? (
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <Path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4 4 0 0 1 0 9z" stroke={C.muted} strokeWidth={2} strokeLinejoin="round" />
        </Svg>
      ) : null}
      <T style={[{ flex: 1, fontSize: 13, lineHeight: 18, color: danger ? C.danger : C.muted }, weight(600)]}>{children}</T>
    </View>
  );
}
