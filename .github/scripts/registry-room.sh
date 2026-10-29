#!/usr/bin/env bash
# MAKE ROOM IN THE CONTAINER REGISTRY — the one copy of the rule, run in three
# places: by `build` before every push, by `prune` after every deploy, and by
# the manual `Registry prune` workflow.
#
# WHY BEFORE THE PUSH. The free registry holds 500 MB and an image adds up to
# ~110 MB. Pruning only after a SUCCESSFUL deploy was a deadlock: once the
# registry was full every push failed with `denied: quota exceeded`, so no
# deploy succeeded, so nothing pruned — and each failed push left ~100 MB of
# untagged layers behind to make it fuller. On 29 October that held every
# merge off production for six hours. Run before the push, a full registry
# delays a deploy by one garbage collection instead of stopping it.
#
# THE RULE.
#   1. Never delete what production is running (read off the droplet) or
#      `latest`. If production's tag cannot be read, keep the newest one more
#      than asked and say so — never guess with the live image.
#   2. Delete every other tag beyond KEEP. A deleted tag is only an old
#      snapshot: every PR it carried is in main and in the image that is live.
#   3. Start a garbage collection (untagged manifests included — that is what
#      a failed push leaves) when the next pushes would not fit, or always
#      with COLLECT=always.
#   4. With WAIT=yes, wait for a collection to FINISH before returning: a push
#      landing inside one fails `401 Unauthorized`, and the push it makes room
#      for is the very next step.
#
# Inputs (environment):
#   KEEP        tags to keep besides `latest` and the live one (default 0)
#   COLLECT     auto | always (default auto)
#   WAIT        yes | no (default no)
#   PUSHES      pushes still to come that must fit (default 2)
#   DO_API_TOKEN, SSH_KEY, SSH_HOSTS, SSH_HOST
# `doctl` must already be installed and signed in (digitalocean/action-doctl).
set -euo pipefail

KEEP="${KEEP:-0}"
COLLECT="${COLLECT:-auto}"
WAIT="${WAIT:-no}"
PUSHES="${PUSHES:-2}"
REGISTRY_API=https://api.digitalocean.com/v2/registry
case "${KEEP}" in
  ''|*[!0-9]*) echo "::error::KEEP must be a whole number of tags, not '${KEEP}'. Nothing deleted."; exit 1 ;;
esac

# ---- 1. what production is running ------------------------------------------
LIVE=""
if [ -n "${SSH_KEY:-}" ] && [ -n "${SSH_HOST:-}" ]; then
  mkdir -p ~/.ssh
  printf '%s\n' "${SSH_KEY}" > ~/.ssh/registry_room_key && chmod 600 ~/.ssh/registry_room_key
  printf '%s\n' "${SSH_HOSTS:-}" >> ~/.ssh/known_hosts
  if image="$(ssh -i ~/.ssh/registry_room_key -o BatchMode=yes -o ConnectTimeout=20 deploy@"${SSH_HOST}" 'grep "^IMAGE=" /opt/mahekone/.env' 2>/dev/null | head -1)"; then
    LIVE="${image##*:}"
  fi
fi
if [ -n "${LIVE}" ]; then
  echo "Production is on ${LIVE}"
else
  echo "::warning title=Live image unknown::Could not read what production is running, so the newest tag is kept as well and nothing older than it is assumed safe."
  KEEP=$(( KEEP < 1 ? 1 : KEEP ))
fi

# ---- 2. delete every other tag beyond KEEP --------------------------------------
# JSON, not `--format`: doctl prints all four columns with the header whatever
# it is asked for, so a column-position read takes the manifest digest.
doctl registry repository list-tags app -o json > /tmp/tags.json
KEEP="${KEEP}" LIVE="${LIVE}" node -e '
  const rows = require("/tmp/tags.json");
  const keepCount = Number(process.env.KEEP);
  const live = (process.env.LIVE || "").trim();
  const named = rows.filter(r => r.tag).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const protect = new Set(["latest"]);
  if (live) protect.add(live);
  const keep = new Set([...protect, ...named.filter(r => !protect.has(r.tag)).slice(0, keepCount).map(r => r.tag)]);
  const del = named.filter(r => !keep.has(r.tag)).map(r => r.tag);
  console.error(`keeping: ${[...keep].join(", ")}`);
  /* The trailing newline matters: `read` skips an unterminated last line. */
  process.stdout.write(del.length ? del.join("\n") + "\n" : "");
' > /tmp/delete.txt
deleted=0
while read -r tag || [ -n "${tag:-}" ]; do
  [ -z "${tag}" ] && continue
  echo "Deleting ${tag}"
  doctl registry repository delete-tag app "${tag}" --force && deleted=$(( deleted + 1 )) || true
done < /tmp/delete.txt
echo "Deleted ${deleted} tag(s)."

# ---- 3. is a collection needed --------------------------------------------------
# Anything that cannot be read is answered "collect": an unknown never risks a
# push failing on quota.
need=yes
if [ "${COLLECT}" != "always" ]; then
  auth="Authorization: Bearer ${DO_API_TOKEN}"
  if curl -fsS -H "${auth}" "${REGISTRY_API}" > /tmp/registry.json \
    && curl -fsS -H "${auth}" "${REGISTRY_API}/subscription" > /tmp/subscription.json \
    && name="$(node -p 'require("/tmp/registry.json").registry.name')" \
    && curl -fsS -H "${auth}" "${REGISTRY_API}/${name}/repositories/app/digests?per_page=200" > /tmp/manifests.json; then
    need="$(PUSHES="${PUSHES}" DELETED="${deleted}" node -e '
      const reg = require("/tmp/registry.json").registry || {};
      const tier = (require("/tmp/subscription.json").subscription || {}).tier || {};
      const manifests = (require("/tmp/manifests.json").manifests || [])
        .filter(m => m.updated_at).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const used = Number(reg.storage_usage_bytes);
      const quota = Number(tier.included_storage_bytes);
      const readAtRaw = reg.storage_usage_updated_at ?? reg.storage_usage_bytes_updated_at;
      const readAt = Date.parse(readAtRaw);
      if (!(used > 0) || !(quota > 0) || !Number.isFinite(readAt) || manifests.length === 0) {
        console.error(`registry: used=${reg.storage_usage_bytes} quota=${tier.included_storage_bytes} readAt=${readAtRaw} manifests=${manifests.length}`);
        console.error("::warning::Could not read how full the registry is, so a collection is started.");
        console.log("yes");
        process.exit(0);
      }
      /* What a push adds: the blobs an image has that the one before it does not, the largest over the newest three pairs. */
      const blobs = m => new Map((m.blobs || []).map(b => [b.digest, Number(b.compressed_size_bytes) || 0]));
      const whole = m => Number(m.compressed_size_bytes) || 0;
      let push = manifests.length === 1 ? whole(manifests[0]) : 0;
      for (let i = 0; i < Math.min(3, manifests.length - 1); i++) {
        const mine = blobs(manifests[i]), before = blobs(manifests[i + 1]);
        let added = 0;
        for (const [d, size] of mine) if (!before.has(d)) added += size;
        push = Math.max(push, mine.size === 0 ? whole(manifests[i]) : added);
      }
      const unseen = manifests.filter(m => Date.parse(m.updated_at) > readAt).length;
      const wanted = (unseen + Number(process.env.PUSHES)) * push;
      const free = quota - used;
      const mb = b => `${Math.round(b / 1e6)} MB`;
      console.error(`registry: ${mb(used)} of ${mb(quota)} as of ${readAtRaw}, ${unseen} push(es) since; a push adds up to ${mb(push)}; ${mb(free)} free, ${mb(wanted)} wanted.`);
      /* Tags deleted just now free nothing until a collection: collect for them too. */
      console.log(push > 0 && free >= wanted && Number(process.env.DELETED) === 0 ? "no" : "yes");
    ')" || need=yes
  else
    echo "::warning::The registry API did not answer, so a collection is started."
  fi
fi

active() {
  doctl registry garbage-collection get-active -o json > /tmp/gc.json 2>/dev/null && [ -s /tmp/gc.json ] && grep -q '"uuid"' /tmp/gc.json
}

if [ "${need}" = "yes" ]; then
  if doctl registry garbage-collection start --include-untagged-manifests --force; then
    echo "::notice::Garbage collection started."
  else
    echo "::notice::A garbage collection was already running."
  fi
else
  echo "::notice::Room for the next pushes; no garbage collection needed."
fi

# ---- 4. wait for a collection to finish, where a push follows -------------------
# DigitalOcean starts a collection only once every push token issued before it
# has expired (about a quarter of an hour); the collection then takes seconds.
# Bounded: a deploy is never held for ever, and the push's own error is a
# better report than one invented here.
if [ "${WAIT}" = "yes" ]; then
  deadline=$(( SECONDS + 1800 ))
  while active; do
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      echo "::warning title=Still collecting::A garbage collection was still running after 30 minutes. Pushing anyway; a 401 now is the collection, not the credential."
      break
    fi
    echo "A garbage collection is running; the registry is read-only. Waiting 30s."
    sleep 30
  done
  echo "No collection running; the registry takes pushes."
fi
