# Desktop range, AppFrame, CardGrid, table widths

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE DESKTOP RANGE IS THE FRAME'S, AND IT IS STATED ONCE.** MahekOne is a
desk product — the telecaller works a queue and the manager reads dense tables,
and the field team has MBOS on a handset rather than a browser — so the
question is not whether it reaches a phone. It is whether it is honest between
a 1366 laptop and a 2560 monitor, and it was not: eight app roots each stated
their own floor and three of them stated none, so HRMS, Enquiries, Reports and
Founder simply crushed. `components/shell/app-frame.tsx` owns the full-height
column, the scroll model, the sidebar row, the floor
(`--container-shell-floor`) and the measure (`--container-measure`), and every
app renders it. It is deliberately NOT the header: a scope switch, a team line
and a module tab strip are genuinely different things, and one component
carrying all of them would be a component with four modes.

**The measure is capped and the maps opt out.** Past about 1600px nothing is
cramped and everything is stretched — a figure card pulled to 420px is a number
adrift in a box. The content stops growing and the rest of the screen becomes
margin. The Sales Dashboard passes `bleed`, because Live tracking and Territory
are maps and a map is the one thing genuinely better for being bigger.

**A card shelf is a `CardGrid`, never a column count.** `grid-cols-4` is right
at exactly one width: four cramped cards at 1280 and four stretched ones at
1920. `auto-fit` with a floor states the true thing — this kind of card stops
being readable below N pixels — and the eighteen hand-typed copies of that
template carried nine different minima between them. The minima are NOT rounded
to a scale: 96px unit chips and 420px target panels are different things.

**A table may not promise its columns more width than it reserves.** `Table` is
`table-fixed`, so declared widths ARE the layout, and over-subscribing
`minWidth` makes the browser shrink them silently — the column comes out
narrower than the number beside it says and truncates early. Ten tables were
over by 20 to 200 pixels. `table-widths.test.ts` reads both spellings, the
`width` prop and the third argument of the local `head()` helper.
