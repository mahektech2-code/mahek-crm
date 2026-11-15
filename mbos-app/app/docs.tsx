import React from 'react';
import { Pressable, RefreshControl, SectionList, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
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

  const h = HERO.lavender;
  /* V3 calls the third chip "On phone"; the filter is the same one, and the
     screen reader still hears what it means. */
  const shownChips = React.useMemo(
    () => chips.map((c) => (c.value === 'offline' ? { ...c, label: 'On phone' } : c)),
    [chips],
  );

  return (
    <AppFrame
      tone="canvas"
      title="Documents"
      activeTab={null}
      onBack={back.go}
      scroll={false}
      hero={
        <View style={{ marginTop: 6, gap: 14 }}>
          {docs === null || all.length === 0 ? (
            <Text style={[{ fontSize: 14, color: h.muted }, weight(600)]}>
              {docs === null ? 'Looking…' : 'Nothing published yet'}
            </Text>
          ) : (
            <View
              accessible
              accessibilityLabel={`${plural(all.length, 'document')} · ${onPhone} on this phone`}
              style={{ flexDirection: 'row', gap: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Glyph shapes={DOC_GLYPH} size={16} color={h.muted} />
                <Text style={[{ fontSize: 14, color: h.muted }, weight(600)]}>{all.length}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Glyph shapes={PHONE_TICK} size={16} color={C.success} />
                <Text style={[{ fontSize: 14, color: C.success }, weight(600)]}>{onPhone} on this phone</Text>
              </View>
            </View>
          )}
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
              <ChipRow
                chips={shownChips}
                value={activeFilter}
                onChange={setFilter}
                counts={counts}
                decor={{
                  new: { ink: C.primaryDeep },
                  offline: { icon: 'tick', ink: C.success, iconInk: C.success },
                }}
              />
            </>
          ) : null}
        </View>
      }>
      {docs === null ? null : all.length === 0 ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <EmptyRow
            glyph={DOC_GLYPH}
            title="Nothing published yet"
            body="Price lists, catalogues and policies show here when the office publishes them."
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
          contentContainerStyle={{ paddingTop: 4, paddingBottom: 32 }}
          ListEmptyComponent={
            <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
              {query.trim() ? (
                <NoMatch query={query.trim()} />
              ) : activeFilter === 'offline' ? (
                <EmptyRow
                  glyph={PHONE_TICK}
                  tint={{ bg: C.successBg, ink: C.success }}
                  title="Nothing on this phone yet"
                  body="Open one once with signal; it then opens without signal."
                  a11y="Open a document once while you have signal and it stays here to open without signal."
                />
              ) : activeFilter === 'new' ? (
                <EmptyRow
                  text="New"
                  tint={{ bg: C.primaryTint, ink: C.primaryDeep }}
                  title="Nothing new this week"
                  body="Published in the last seven days shows here."
                />
              ) : (
                <EmptyRow glyph={FOLDER_GLYPH} title="Nothing here" body="Choose All to see every document." />
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

const DOC_GLYPH: GlyphShape[] = [{ p: 'M7 3h7l5 5v13H7z' }, { p: 'M14 3v5h5' }];
const PHONE_TICK: GlyphShape[] = [{ r: [7, 3, 10, 18, 2] }, { p: 'M10 12l2 2 3-4' }];
const FOLDER_GLYPH: GlyphShape[] = [{ p: 'M3 7h7l2 2h9v10H3z' }];

/* ----------------------------------------------------------------- parts */

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View
      accessibilityRole="header"
      accessible
      accessibilityLabel={`${title}, ${count}`}
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 14,
        paddingBottom: 8,
        backgroundColor: C.canvas,
      }}>
      <Text style={[{ fontSize: 13, color: C.ink }, weight(800)]}>{title}</Text>
      <Text style={[{ fontSize: 13, color: C.faint }, weight(800)]}>{count}</Text>
    </View>
  );
}

function SectionGap() {
  return <View style={{ height: 4 }} />;
}

const TILE = {
  pdf: { bg: C.dangerBg, ink: C.danger },
  image: { bg: C.infoBg, ink: C.info },
  other: { bg: C.canvas, ink: C.muted },
} as const;

/**
 * One document. The rows of a section are drawn as one card — rounded at the
 * first and the last, a hairline between — so a group reads as a group and
 * the list stays dense.
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
      accessibilityLabel={`${d.title}${fresh ? ', new' : ''}${d.onPhone ? ', on this phone' : ', download, needs signal'}`}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        paddingHorizontal: 14,
        backgroundColor: pressed ? C.wash : C.surface,
        borderTopLeftRadius: first ? radius.card : 0,
        borderTopRightRadius: first ? radius.card : 0,
        borderBottomLeftRadius: last ? radius.card : 0,
        borderBottomRightRadius: last ? radius.card : 0,
      })}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 72,
          paddingVertical: 10,
          borderTopWidth: first ? 0 : 1,
          borderTopColor: C.hairline,
        }}>
        <View
          style={{
            width: 40,
            height: 48,
            borderRadius: 10,
            backgroundColor: tile.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Text style={[{ fontSize: 10, color: tile.ink }, weight(800)]}>{fileBadge(d.kind)}</Text>
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]} numberOfLines={2}>
            {d.title}
          </Text>
          {d.description ? (
            <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted }} numberOfLines={1}>
              {d.description}
            </Text>
          ) : null}
          {fresh || meta ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
              {fresh ? (
                <View
                  style={{
                    height: 22,
                    paddingHorizontal: 8,
                    borderRadius: 11,
                    backgroundColor: C.primaryTint,
                    justifyContent: 'center',
                  }}>
                  <Text style={[{ fontSize: 12, color: C.primaryDeep }, weight(700)]}>New</Text>
                </View>
              ) : null}
              {meta ? <Text style={{ fontSize: 12, color: C.muted }}>{meta}</Text> : null}
            </View>
          ) : null}
        </View>

        {/* Whether a tap needs signal: a tick means it opens anywhere. */}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: d.onPhone ? C.successBg : C.canvas,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Icon
            name={d.onPhone ? 'tick' : 'download'}
            size={18}
            color={d.onPhone ? C.success : C.muted}
            strokeWidth={d.onPhone ? 2.4 : 2}
          />
        </View>
      </View>
    </Pressable>
  );
});

/** No document matches what he typed — the one empty answer drawn large. */
function NoMatch({ query }: { query: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`Nothing matches “${query}”. Try one word from the title, or clear the search to see everything.`}
      style={{ backgroundColor: C.surface, borderRadius: 24, paddingVertical: 26, paddingHorizontal: 18, alignItems: 'center' }}>
      <Icon name="search" size={30} color={C.faint} strokeWidth={2} />
      <Text style={[{ fontSize: 17, color: C.ink, textAlign: 'center', marginTop: 8 }, weight(800)]}>
        {`Nothing matches “${query}”`}
      </Text>
      <Text style={{ fontSize: 13, color: C.muted, textAlign: 'center', marginTop: 4 }}>
        Try one word from the title, or clear the search.
      </Text>
    </View>
  );
}

/** The quieter empty answers: a disc, a title and one line. */
function EmptyRow({
  glyph,
  text,
  tint = { bg: C.canvas, ink: C.muted },
  title,
  body,
  a11y,
}: {
  glyph?: GlyphShape[];
  text?: string;
  tint?: { bg: string; ink: string };
  title: string;
  body: string;
  a11y?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${a11y ?? body}`}
      style={{ backgroundColor: C.surface, borderRadius: 20, padding: 16, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: tint.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        {text ? (
          <Text style={[{ fontSize: 12, color: tint.ink }, weight(800)]}>{text}</Text>
        ) : glyph ? (
          <Glyph shapes={glyph} size={20} color={tint.ink} />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[{ fontSize: 15, color: C.ink }, weight(700)]}>{title}</Text>
        <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted }}>{body}</Text>
      </View>
    </View>
  );
}
