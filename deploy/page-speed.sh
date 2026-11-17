#!/usr/bin/env bash
#
# HOW SLOW EACH SCREEN REALLY IS, for the people using it, read off Caddy's
# access log. Read-only: it reads the log and prints a table.
#
#   cd /opt/mahekone && bash page-speed.sh          # the last 24 hours
#   bash page-speed.sh 2                            # the last 2 hours
#
# Caddy writes one JSON line per request (Caddyfile, `log`) and each carries
# `duration` — from the request arriving to the last byte leaving, which is the
# wait somebody actually sat through. Measured anywhere else (a laptop, a test
# database, one request at a time) the numbers leave out the one thing that
# makes production slow: everybody else's requests on the same CPU.
#
# Ids in a path are folded to `:id`, so every customer record is one row.
# Static files and the two live streams (which stay open on purpose) are left
# out. p95 is the number to watch: one request in twenty is at least this slow.
#
# Needs python3, which Ubuntu ships.

set -euo pipefail
hours="${1:-24}"

docker compose exec -T caddy sh -c 'cat /data/access*.log 2>/dev/null' \
  | python3 -c '
import json, re, sys, time
hours = float(sys.argv[1])
since = time.time() - hours * 3600
ID = re.compile(r"^(?:[0-9a-f-]{20,}|[a-z]{2,6}_[0-9a-z_-]{6,}|\d+|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{5,})$")
SKIP = ("/_next/", "/favicon", "/icon", "/apple-icon", "/downloads/")
groups, slow, statuses = {}, [], {}
for line in sys.stdin:
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if e.get("ts", 0) < since:
        continue
    req = e.get("request", {})
    uri = req.get("uri", "")
    path = uri.split("?", 1)[0]
    if path.startswith(SKIP) or path.endswith("/stream"):
        continue
    key = req.get("method", "GET") + " " + "/".join(":id" if ID.match(s) else s for s in path.split("/"))
    d = float(e.get("duration", 0))
    groups.setdefault(key, []).append(d)
    st = int(e.get("status", 0)) // 100
    statuses[st] = statuses.get(st, 0) + 1
    if d >= 3:
        slow.append((d, time.strftime("%d %b %H:%M", time.localtime(e["ts"])), uri[:90]))

def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))]

every = [d for xs in groups.values() for d in xs]
if not every:
    sys.exit("no requests in the last %g hours" % hours)
print("Last %g h: %d requests  p50 %.2fs  p95 %.2fs  (%s)" % (hours, len(every), pct(every, .5), pct(every, .95),
      "  ".join("%dxx %d" % (k, v) for k, v in sorted(statuses.items()))))
print()
print("%-58s %6s %7s %7s %7s %9s" % ("screen", "count", "p50", "p95", "max", "total s"))
rows = sorted(groups.items(), key=lambda kv: -sum(kv[1]))
for k, xs in rows[:40]:
    print("%-58s %6d %6.2fs %6.2fs %6.2fs %9.0f" % (k[:58], len(xs), pct(xs, .5), pct(xs, .95), max(xs), sum(xs)))
print()
print("Sorted by total time: the top rows are where speeding up one screen saves the team the most waiting.")
if slow:
    print()
    print("Slowest single requests (3 s or more):")
    for d, at, uri in sorted(slow, reverse=True)[:15]:
        print("  %5.1fs  %s  %s" % (d, at, uri))
' "$hours"
