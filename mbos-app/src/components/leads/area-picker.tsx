import React from 'react';
import { Pressable, View } from 'react-native';
import { Choice, SectionLabel, T } from '../ui/primitives';
import { SearchBox } from '../ui/book-controls';
import { Icon } from '../ui/Icon';
import { color as C, radius, weight } from '../../theme/tokens';
import { grouped, plural } from '../../lib/format';
import type { AreaChoice } from '../../engines/lead-areas';
import {
  areaFacts,
  areaName,
  areaParent,
  nearLabel,
  searchAreas,
  suggestAreas,
  type AreaFacts,
  type BookPlace,
} from '../../engines/area-picker';
import { bookPlaceCounts, bookPlacesNear, recentAreaKeys } from '../../data/lead-areas';
import { recentFix } from '../../native/where';

/**
 * THE AREA ON THE NEW LEAD FORM.
 *
 * A handful of areas are still chips, because one tap beats two. Past
 * `CHIP_LIMIT` the field becomes a single row that opens `AreaPickerPage` —
 * search first, his nearest areas offered before he types, the list capped
 * and the rest counted. See `engines/area-picker.ts` for the ordering.
 *
 * The page is drawn INSIDE the form's own sheet rather than as a second sheet
 * over it: the app never stacks two, and closing the form to open a picker
 * would animate the half-typed lead away and back for one tap.
 */

/** At or below this many, every area is a chip on the form. */
export const CHIP_LIMIT = 8;

export function AreaField({
  choices,
  picked,
  onPick,
  onOpen,
}: {
  choices: AreaChoice[];
  picked: AreaChoice | null;
  onPick: (a: AreaChoice) => void;
  onOpen: () => void;
}) {
  if (choices.length <= CHIP_LIMIT) {
    return (
      <>
        <SectionLabel style={{ marginBottom: 6 }}>Area</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {choices.map((a) => (
            <Choice
              key={a.key}
              label={a.label}
              selected={picked?.key === a.key}
              onPress={() => onPick(a)}
              style={{ paddingHorizontal: 14 }}
            />
          ))}
        </View>
      </>
    );
  }
  const parent = picked ? areaParent(picked) : null;
  return (
    <>
      <SectionLabel style={{ marginBottom: 6 }}>Area</SectionLabel>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={picked ? `Area: ${picked.label}. Change it` : 'Choose the area'}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 52,
          paddingHorizontal: 14,
          paddingVertical: 10,
          marginBottom: 12,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: picked ? C.primaryEdge : C.border,
          backgroundColor: pressed ? C.wash : picked ? C.primaryTint : C.surface,
        })}>
        <Icon name="pin" size={18} color={picked ? C.primaryDeep : C.muted} strokeWidth={1.6} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {picked ? (
            <>
              <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(600)]}>
                {areaName(picked)}
              </T>
              {parent ? (
                <T s="caption" numberOfLines={1}>
                  {parent}
                </T>
              ) : null}
            </>
          ) : (
            <>
              <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>Choose the area</T>
              <T s="caption">{`Search your ${grouped(choices.length)} areas`}</T>
            </>
          )}
        </View>
        <T style={[{ fontSize: 13, color: C.primaryDeep }, weight(600)]}>{picked ? 'Change' : 'Choose'}</T>
      </Pressable>
    </>
  );
}

type Loaded = {
  book: BookPlace[];
  nearby: BookPlace[];
  recent: string[];
  fix: { lat: number; lng: number } | null;
};

export function AreaPickerPage({
  choices,
  pickedKey,
  onPick,
  onBack,
}: {
  choices: AreaChoice[];
  pickedKey: string | null;
  onPick: (a: AreaChoice) => void;
  onBack: () => void;
}) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const [book, recent, fix] = await Promise.all([
        bookPlaceCounts().catch(() => [] as BookPlace[]),
        recentAreaKeys(),
        recentFix().catch(() => null),
      ]);
      const nearby = fix ? await bookPlacesNear(fix).catch(() => [] as BookPlace[]) : [];
      if (alive) setLoaded({ book, nearby, recent, fix });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const facts = React.useMemo(
    () => areaFacts(choices, loaded?.book ?? [], loaded?.fix ?? null, loaded?.nearby ?? []),
    [choices, loaded],
  );
  const suggested = React.useMemo(
    () => (loaded ? suggestAreas(choices, facts, loaded.recent) : []),
    [choices, facts, loaded],
  );
  const found = React.useMemo(() => searchAreas(choices, facts, query), [choices, facts, query]);
  const asking = query.trim().length > 0;

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to the lead"
          hitSlop={10}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            borderRadius: radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? C.wash : 'transparent',
          })}>
          <Icon name="back" size={20} color={C.ink} strokeWidth={1.8} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <T style={[{ fontSize: 19, lineHeight: 25, color: C.ink }, weight(600)]}>Which area is the shop in?</T>
          <T s="caption">{plural(choices.length, 'area') + ' are yours'}</T>
        </View>
      </View>

      {/* Focused straight away only where there is nothing to offer first —
          with suggestions on the screen the keyboard would cover the answer. */}
      <View style={{ flexDirection: 'row', marginBottom: 8 }}>
        <SearchBox
          /* `autoFocus` is read on mount, and the suggestions arrive after it —
             so the box mounts again once they have, keeping what was typed. */
          key={loaded ? 'ready' : 'loading'}
          value={query}
          onChange={setQuery}
          onClear={() => setQuery('')}
          placeholder="Type a town or beat"
          autoFocus={loaded != null && suggested.length === 0}
        />
      </View>

      {!asking && suggested.length > 0 ? (
        <>
          <SectionLabel style={{ marginTop: 8, marginBottom: 2 }}>
            {suggested[0].why === 'near' ? 'Near you' : 'You used recently'}
          </SectionLabel>
          {suggested.map((s, i) => (
            <React.Fragment key={'s' + s.choice.key}>
              {i > 0 && s.why === 'recent' && suggested[i - 1].why === 'near' ? (
                <SectionLabel style={{ marginTop: 12, marginBottom: 2 }}>You used recently</SectionLabel>
              ) : null}
              <AreaRow
                choice={s.choice}
                facts={facts.get(s.choice.key)}
                picked={pickedKey === s.choice.key}
                nearM={s.nearM}
                onPress={() => onPick(s.choice)}
              />
            </React.Fragment>
          ))}
          <SectionLabel style={{ marginTop: 16, marginBottom: 2 }}>All your areas</SectionLabel>
        </>
      ) : null}

      {found.total === 0 ? (
        <T s="caption" style={{ paddingVertical: 16 }}>
          {`No area of yours is called “${query.trim()}”. A lead can only be added in your own area. If this shop should be yours, ask the office to add the area.`}
        </T>
      ) : (
        found.rows.map((c) => (
          <AreaRow
            key={c.key}
            choice={c}
            facts={facts.get(c.key)}
            picked={pickedKey === c.key}
            nearM={null}
            onPress={() => onPick(c)}
          />
        ))
      )}

      {found.total > found.rows.length ? (
        <T s="caption" style={{ paddingTop: 12, textAlign: 'center' }}>
          {`Showing ${grouped(found.rows.length)} of ${grouped(found.total)}. Type more of the name to find the rest.`}
        </T>
      ) : null}
    </View>
  );
}

function AreaRow({
  choice,
  facts,
  picked,
  nearM,
  onPress,
}: {
  choice: AreaChoice;
  facts: AreaFacts | undefined;
  picked: boolean;
  nearM: number | null;
  onPress: () => void;
}) {
  const parent = areaParent(choice);
  const shops = facts?.shops;
  /* What kind of place it is, in words: a state asks for the town next, and
     saying so here saves the surprise of a second question after the tap. */
  const sub = [
    choice.area ? (parent ? `Beat in ${parent}` : 'Beat') : choice.city ? (parent ?? 'Town') : 'Whole state · you type the town',
    shops ? `${grouped(shops)} of your shops` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: picked }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        backgroundColor: pressed ? C.wash : picked ? C.primaryTint : 'transparent',
      })}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={1} style={[{ fontSize: 15, color: C.ink }, weight(picked ? 600 : 500)]}>
          {areaName(choice)}
        </T>
        <T s="caption" numberOfLines={1}>
          {sub}
        </T>
      </View>
      {nearM != null ? (
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: radius.pill,
            backgroundColor: C.primaryTint,
          }}>
          <T style={[{ fontSize: 12, color: C.primaryDeep }, weight(600)]}>{nearLabel(nearM)}</T>
        </View>
      ) : null}
      {picked ? <Icon name="tick" size={18} color={C.primaryDeep} strokeWidth={2.2} /> : null}
    </Pressable>
  );
}
