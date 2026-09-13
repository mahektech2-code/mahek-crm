"use client";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import { useState } from "react";
import { createPortal } from "react-dom";

/* ---------------------------------------------------------------------------
 * THE ONE NAV LINK, for both apps.
 *
 * A tab change here used to produce NOTHING for as long as the server took.
 * Every screen is a dynamic render, there was no `loading.tsx` anywhere in the
 * tree, and the sidebar carried `prefetch={false}` — so Next had no shell to
 * show, nothing to stream, and nothing in the client cache. The browser held
 * the old page, unchanged and unmarked, until the whole payload arrived. On
 * production the Manager Console answers most tabs in 40–150 ms and it still
 * read as slow, because 150 ms of absolutely no feedback is indistinguishable
 * from a click that missed.
 *
 * Three things fix that, and they are in a deliberate order:
 *
 *   1. `loading.tsx` at each app root, so a navigation can COMMIT immediately
 *      — the URL changes, the sidebar highlight moves, a skeleton paints —
 *      while the page's own data is still being read.
 *
 *   2. Prefetch, so the shell is usually in the client cache before the click
 *      and step 1 costs no round trip at all.
 *
 *   3. This bar, for the gap that is left: the first visit to a tab nobody has
 *      hovered, on a phone, on a bad connection.
 *
 * WHY PREFETCH IS ON HOVER RATHER THAN ON SIGHT. The old `prefetch={false}`
 * was not a mistake — its comment records that the default fired a full render
 * of all fourteen destinations on every navigation and drowned the one shared
 * vCPU this app runs on. Both halves of that are now different: with a loading
 * boundary a prefetch stops at that boundary instead of rendering the page, so
 * it is cheap; and asking on hover means one destination rather than fourteen.
 * Next's own guidance names this pattern for exactly this case — a list of
 * links that are all permanently in view. A pointer arrives 100–300 ms before
 * the click, which is the whole budget we need.
 *
 * `prefetch={null}` is "do the default", not "off" — the hook is `warm`, and a
 * link only becomes warm once somebody has pointed at it.
 * ------------------------------------------------------------------------- */

export function NavLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Link>, "href" | "prefetch" | "className">) {
  const [warm, setWarm] = useState(false);
  const warmUp = () => setWarm(true);

  return (
    <Link
      {...rest}
      href={href}
      prefetch={warm ? null : false}
      onMouseEnter={warmUp}
      onFocus={warmUp}
      onTouchStart={warmUp}
      className={className}
    >
      {children}
      <NavProgress />
    </Link>
  );
}

/**
 * The bar across the top of the window while a navigation is in flight.
 *
 * IT IS A TRICKLE AND NOT A PERCENTAGE, because a percentage would be a
 * number we do not have. Nothing on the client knows how far through a server
 * render is — the only honest signals are "started" and "committed", and a bar
 * that claimed 47% would be inventing the middle. What it does instead is
 * approach the right-hand edge without ever reaching it, and vanish when the
 * page commits. That is the shape every browser already teaches people to
 * read, and it cannot be wrong about anything.
 *
 * A PORTAL, because the bar belongs to the window and the link belongs to a
 * sidebar that scrolls. `useLinkStatus` only reports from inside a `<Link>`,
 * so the hook has to live here; where it DRAWS is a separate question.
 *
 * `pending` is false during the server render, so `document` is never touched
 * there and hydration matches.
 */
function NavProgress() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return createPortal(
    <span className="nav-progress" role="presentation" aria-hidden="true" />,
    document.body,
  );
}
