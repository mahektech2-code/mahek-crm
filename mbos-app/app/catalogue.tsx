import React from 'react';
import { View, FlatList } from 'react-native';
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
  return <View style={{ height: 1, backgroundColor: C.wash }} />;
}

export default function CatalogueScreen() {
  const back = useCameFrom('more');
  const catQ = useStore((s) => s.catQ);
  const set = useStore((s) => s.set);

  const [rows, setRows] = React.useState<Row[]>([]);
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
      void searchProducts(catQ || '', 200)
        .then((r) => {
          if (!live) return;
          setRows(r);
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

  const renderRow = ({ item: x }: { item: Row }) => (
    /* NOT PRESSABLE. Every row used to be a button whose whole effect was a
       2.4-second toast at the far end of the screen, `pointerEvents="none"`,
       restating four things already printed on the row — so it read as a
       product detail he could open, and what he got vanished before he had
       read it out. The one fact the toast carried that the row did not was
       cans per box, which is on the subtitle now. */
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{x.name}</T>
        {/* Depot stock is not in the payload, so the row carries the
            formulation instead of a confident "In stock" nothing has
            checked — one liquid sells under three names, and this is
            what separates two SKUs read out mid-conversation. */}
        <T style={{ fontSize: 13, color: C.muted }}>
          {[x.formulation ?? x.brand, x.cansPerBox ? x.cansPerBox + ' per box' : null]
            .filter(Boolean)
            .join(' · ')}
        </T>
      </View>
      <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>
        {(x.sellingPricePaise != null ? inr(x.sellingPricePaise / 100) + ' / ' : '') + (x.packSize ?? '')}
      </T>
    </View>
  );

  /* Nothing terminal until the read has answered, and a catalogue that never
     arrived is a different sentence from a word that matched nothing. */
  const blank = !loaded ? (
    <Line>Reading the catalogue…</Line>
  ) : failed ? (
    <Line>
      {'Could not read the catalogue off this phone. Leave the screen and come back, and if it keeps happening tell the office.'}
    </Line>
  ) : asked ? (
    <Line>{'Nothing matches that. Try the grade, like "epoxy".'}</Line>
  ) : (
    <Line>
      {'The product list has not reached this phone yet. It arrives with a sync — open Sync from the More tab when you have signal.'}
    </Line>
  );

  return (
    <AppFrame
      title="Product catalogue"
      activeTab={null}
      onBack={back.go}
      scroll={false}
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Product catalogue</T>

      <Input
        value={typed}
        onChangeText={setTyped}
        placeholder="Search a product or pack size"
        style={{ marginTop: 12 }}
      />
      {/* The count is a count of what came back. Silent until the read has
          answered, because "0 products" about a query still running is the
          same false verdict in a shorter sentence. */}
      <T s="caption" style={{ marginTop: 8 }}>
        {loaded && !failed ? plural(rows.length, 'product') : ' '}
      </T>

      {rows.length === 0 ? (
        blank
      ) : (
        <ListCard style={{ flex: 1, marginTop: 12 }}>
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
          />
        </ListCard>
      )}
    </AppFrame>
  );
}

/** One centred sentence in a card — the shape all four blank states share. */
function Line({ children }: { children: React.ReactNode }) {
  return (
    <Card padded={false} style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 32 }}>
      <T style={{ fontSize: 15, color: C.muted, textAlign: 'center' }}>{children}</T>
    </Card>
  );
}
