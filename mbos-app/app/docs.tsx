import React from 'react';
import { Pressable, RefreshControl, SectionList, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, T } from '../src/components/ui/primitives';
import { ChipRow, SearchBox } from '../src/components/ui/book-controls';
import { Icon } from '../src/components/ui/Icon';
import { color as C, radius, weight } from '../src/theme/tokens';
import { heldFile, listDocuments } from '../src/data/library';
import {
  fileBadge,
  fileKind,
  filterChips,
  filterCounts,
  isNew,
  librarySections,
  type LibraryDoc,
  type LibraryFilter,
  type LibrarySection,
} from '../src/lib/library-view';
import { dmy, isoDate, plural } from '../src/lib/format';
import { syncNow } from '../src/sync/engine';

/**
 * The papers he needs in a shop with no signal — and, now, hundreds of them.
 *
 * It was a flat alphabetical list ending in "Tap to download", which held five
 * documents comfortably and holds three hundred not at all: the price list he
 * wants in front of a customer is somewhere in the middle and he scrolls past
 * it looking. So the screen is a library now — a search box that reads the
 * title, the description and the category; chips that narrow to what is new,
 * what is already on this phone, or one category, each saying how many it
 * holds before it is pressed; and the rest grouped by category in a fixed
 * order, alphabetical inside, so nothing moves while he is looking for it.
 * Every one of those rules is in `lib/library-view.ts`, pure and tested.
 *
 * A tap opens the document INSIDE the app (`doc-view`), downloading it first
 * if it is not here yet. It used to hand the file to another app, which on
 * most of these phones meant nothing happened at all.
 */

export default function DocsScreen() {
  const back = useCameFrom('more');
  const [docs, setDocs] = React.useState<LibraryDoc[] | null>(null);
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<LibraryFilter>('all');
  const [now, setNow] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);

  const reload = React.useCallback(async () => {
    setNow(Date.now());
    try {
      const rows = await listDocuments();
      setDocs(
        rows.map((d) => ({
          id: d.id,
          title: d.title,
          category: d.category,
          description: d.description,
          kind: d.kind,
          sizeLabel: d.sizeLabel,
          publishedAt: d.publishedAt,
          onPhone: heldFile(d) !== null,
        })),
      );
    } catch {
      setDocs([]);
    }
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      void reload();
    }, [reload]),
  );

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await syncNow({ manual: true }).catch(() => undefined);
      await reload();
    } finally {
      setRefreshing(false);
    }
  }, [reload]);

  const all = React.useMemo(() => docs ?? [], [docs]);
  const chips = React.useMemo(() => filterChips(all), [all]);
  /* A chip that has disappeared — its last document withdrawn — falls back to
     everything rather than leaving the list narrowed to a category that is gone. */
  const activeFilter = chips.some((c) => c.value === filter) ? filter : 'all';
  /* The counts are what each chip would show WITH the search applied, so the
     row answers "where are the matches" while he types. */
  const searched = React.useMemo(
    () => (query.trim() ? (librarySections(all, { query, filter: 'all', now })[0]?.data ?? []) : all),
    [all, query, now],
  );
  const counts = React.useMemo(() => filterCounts(searched, chips, now), [searched, chips, now]);
  const sections = React.useMemo(
    () => librarySections(all, { query, filter: activeFilter, now }),
    [all, query, activeFilter, now],
  );
  const onPhone = all.filter((d) => d.onPhone).length;

  const open = React.useCallback((d: LibraryDoc) => {
    router.push(`/doc-view?id=${encodeURIComponent(d.id)}&from=docs`);
  }, []);

  return (
    <AppFrame title="Documents" activeTab={null} onBack={back.go} scroll={false}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, gap: 10, backgroundColor: C.canvas }}>
        <View>
          <BackLink label={back.label} onPress={back.go} />
          <T s="h1">Documents</T>
          <T s="small" style={{ color: C.muted, marginTop: 2 }}>
            {docs === null
              ? 'Looking…'
              : all.length === 0
                ? 'Nothing published yet'
                : `${plural(all.length, 'document')} · ${onPhone} on this phone`}
          </T>
        </View>
        {all.length > 0 ? (
          <>
            <View style={{ flexDirection: 'row' }}>
              <SearchBox
                value={query}
                onChange={setQuery}
                onClear={() => setQuery('')}
                placeholder="Search price lists, catalogues…"
              />
            </View>
            <ChipRow chips={chips} value={activeFilter} onChange={setFilter} counts={counts} />
          </>
        ) : null}
      </View>

      {docs === null ? null : all.length === 0 ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Empty
            title="Nothing published yet"
            body="Price lists, catalogues and policies will show here when the office publishes them."
          />
        </View>
      ) : (
        <SectionList<LibraryDoc, LibrarySection>
          style={{ flex: 1 }}
          sections={sections}
          keyExtractor={(d) => d.id}
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => <SectionHeader title={section.title} count={section.data.length} />}
          renderItem={({ item, index, section }) => (
            <DocRow d={item} now={now} first={index === 0} last={index === section.data.length - 1} onPress={open} />
          )}
          SectionSeparatorComponent={SectionGap}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListEmptyComponent={
            <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
              {query.trim() ? (
                <Empty
                  title={`Nothing matches “${query.trim()}”`}
                  body="Try one word from the title, or clear the search to see everything."
                />
              ) : activeFilter === 'offline' ? (
                <Empty
                  title="Nothing on this phone yet"
                  body="Open a document once while you have signal and it stays here to open without signal."
                />
              ) : activeFilter === 'new' ? (
                <Empty title="Nothing new this week" body="Documents published in the last seven days show here." />
              ) : (
                <Empty title="Nothing here" body="Choose All to see every document." />
              )}
            </View>
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={9}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        />
      )}
    </AppFrame>
  );
}

/* ----------------------------------------------------------------- parts */

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 6,
        backgroundColor: C.canvas,
      }}>
      <T style={[{ fontSize: 12, letterSpacing: 0.6, color: C.muted, textTransform: 'uppercase' }, weight(600)]}>
        {title}
      </T>
      <T style={[{ fontSize: 12, color: C.muted }, weight(500)]}>{count}</T>
    </View>
  );
}

function SectionGap() {
  return <View style={{ height: 4 }} />;
}

const TILE = {
  pdf: { bg: C.dangerBg, ink: C.danger },
  image: { bg: C.infoBg, ink: C.info },
  other: { bg: C.wash, ink: C.muted },
} as const;

/**
 * One document. The rows of a section are drawn as one card — rounded at the
 * first and the last — so a group reads as a group and the list stays dense.
 */
const DocRow = React.memo(function DocRow({
  d,
  now,
  first,
  last,
  onPress,
}: {
  d: LibraryDoc;
  now: number;
  first: boolean;
  last: boolean;
  onPress: (d: LibraryDoc) => void;
}) {
  const kind = fileKind(d.kind);
  const tile = TILE[kind];
  const fresh = isNew(d, now);
  const meta = [d.sizeLabel, d.publishedAt ? dmy(isoDate(new Date(d.publishedAt))) : null].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => onPress(d)}
      accessibilityRole="button"
      accessibilityLabel={`${d.title}${fresh ? ', new' : ''}${d.onPhone ? ', on this phone' : ''}`}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        backgroundColor: pressed ? C.wash : C.surface,
        borderColor: C.border,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderTopWidth: first ? 1 : 0,
        borderBottomWidth: 1,
        borderBottomColor: last ? C.border : C.hairline,
        borderTopLeftRadius: first ? radius.card : 0,
        borderTopRightRadius: first ? radius.card : 0,
        borderBottomLeftRadius: last ? radius.card : 0,
        borderBottomRightRadius: last ? radius.card : 0,
      })}>
      <View
        style={{
          width: 40,
          height: 48,
          borderRadius: 6,
          backgroundColor: tile.bg,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
        }}>
        <Icon name={kind === 'image' ? 'image' : 'doc'} size={18} color={tile.ink} strokeWidth={1.5} />
        <T style={[{ fontSize: 9, color: tile.ink, letterSpacing: 0.4 }, weight(600)]}>{fileBadge(d.kind)}</T>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(500)]} numberOfLines={2}>
          {d.title}
        </T>
        {d.description ? (
          <T s="small" style={{ color: C.muted, marginTop: 1 }} numberOfLines={1}>
            {d.description}
          </T>
        ) : null}
        {fresh || meta ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {fresh ? (
              <View
                style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: C.primaryTint }}>
                <T style={[{ fontSize: 11, color: C.primaryDeep }, weight(600)]}>New</T>
              </View>
            ) : null}
            {meta ? <T s="caption">{meta}</T> : null}
          </View>
        ) : null}
      </View>

      {/* Whether a tap needs signal: a tick means it opens anywhere. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ alignItems: 'center', width: 40 }}>
        <Icon
          name={d.onPhone ? 'tick' : 'download'}
          size={18}
          color={d.onPhone ? C.success : C.muted}
          strokeWidth={d.onPhone ? 2 : 1.6}
        />
        <T style={{ fontSize: 10, color: d.onPhone ? C.success : C.muted, marginTop: 2 }}>
          {d.onPhone ? 'Saved' : 'Get'}
        </T>
      </View>
    </Pressable>
  );
});

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <Card style={{ paddingHorizontal: 16, paddingVertical: 28 }} padded={false}>
      <T style={[{ fontSize: 16, color: C.ink, textAlign: 'center' }, weight(600)]}>{title}</T>
      <T s="small" style={{ color: C.muted, textAlign: 'center', marginTop: 4 }}>
        {body}
      </T>
    </Card>
  );
}
