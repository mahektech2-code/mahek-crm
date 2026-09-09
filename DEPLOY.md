# Running MahekOne on one droplet

Everything on one machine in Bangalore: Caddy, the app, Postgres. About $7.80
a month, and the database sits on the same box as the app — which is the whole
reason it is cheap, and also why it is fast. Every query is a loopback instead
of a round trip to Virginia.

This replaces Vercel + Neon. Nothing about the application changed to make it
possible: the driver was already `postgres-js`, and only `DATABASE_URL` differs.

---

## What you need before you start

- A droplet: **Regular, 1 GiB / 1 vCPU / 25 GiB, Bangalore (BLR1), Ubuntu 24.04
  LTS**, with **daily backups** and **monitoring** enabled at creation.
- A **reserved IP** attached to it. Free while attached, and it means rebuilding
  the droplet later does not mean editing DNS under pressure.
- Your SSH public key added to the droplet at creation.
- The domain's DNS, at whoever holds it.
- A **DigitalOcean Container Registry** (free tier: one repository, 500 MB),
  named `mahekone`.
- A **Cloudflare R2** bucket, `mahekone-backups`, with an S3 API token.

Keep the Vercel project and the Neon database alive throughout. They are the
rollback, and they stay the rollback for a week after cutover.

---

## 1. Prepare the box

```bash
ssh root@<droplet-ip> 'bash -s' < deploy/bootstrap.sh
```

Swap, sysctls, Docker, the firewall, automatic security updates, `/opt/mahekone`.
Idempotent — run it again if you are unsure it finished.

Then a user for deploys, so CI is not root:

```bash
ssh root@<droplet-ip>
  adduser --disabled-password --gecos "" deploy
  usermod -aG docker deploy
  mkdir -p /home/deploy/.ssh && cp /root/.ssh/authorized_keys /home/deploy/.ssh/
  chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
  chown -R deploy:deploy /opt/mahekone
```

## 2. Put the files on it

```bash
scp deploy/docker-compose.yml Caddyfile \
    deploy/restart.sh deploy/backup.sh deploy/restore.sh deploy/sheet-sync.sh \
    deploy@<droplet-ip>:/opt/mahekone/
scp .env.production.example deploy@<droplet-ip>:/opt/mahekone/.env
ssh deploy@<droplet-ip> 'chmod 600 /opt/mahekone/.env'
```

Now fill in `/opt/mahekone/.env`. Generate the Postgres password with
`openssl rand -base64 32 | tr -d '/+=' | head -c 32` and keep a copy — the
deploy workflow needs the same value as a GitHub secret.

The application's own variables come across from Vercel. Run `vercel env pull`
**while the project still exists** and move the values over. A missed one does
not error: the microphone silently stops being drawn, the sheet sync reports
"not configured".

## 3. Point the domain at it

An `A` record for your domain to the reserved IP. **Do this before the first
start** — Caddy asks Let's Encrypt for a certificate on boot, and Let's Encrypt
verifies by connecting to the name. Wrong order means a failed challenge and a
rate limit you then wait out.

Check it has propagated before continuing: `dig +short crm.mahek.in`.

## 4. Secrets in GitHub

`Settings → Secrets and variables → Actions`:

| Secret | What it is |
|---|---|
| `DROPLET_HOST` | the reserved IP |
| `SSH_PRIVATE_KEY` | private key whose public half is on the droplet |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan <ip>` — pinned, not trust-on-first-use |
| `POSTGRES_PASSWORD` | same value as in `.env` |
| `DOCR_TOKEN` | DigitalOcean registry token, read/write — pushes the image |
| `DO_API_TOKEN` | DigitalOcean **account** API token, read/write — prunes the registry |
| `DOMAIN` | `crm.mahek.in` |

**`DO_API_TOKEN` is a second token on purpose, and the deploy still runs
without it.** `DOCR_TOKEN` is registry-scoped, which is exactly right for
pushing and is why it is not the account token — but a registry credential
cannot list tags or start a garbage collection, and the prune step needs
both. Where it is missing the step logs a warning and the deploy carries on;
what you get instead is the quota, three or four deploys later.

**The registry is 500 MB and an image is about 130 MB.** Nothing used to
remove one, so it filled and the next push failed with `denied: quota
exceeded` — a green test job, a failed build, and the `deploy` job skipped
underneath without a word about storage. It has happened twice: once when the
build cache lived here as `buildcache` tags, and again from the images
themselves. The `prune` job keeps the newest three plus `latest`, and it runs
LAST — after the deploy it is housekeeping for, never before the build.

It used to run first, on the reasoning that a push into a full registry is the
failure it exists to prevent. That reasoning was backwards: DigitalOcean will
not begin collecting until every write-scoped push token has expired, so
starting a collection immediately before this run's own push is asking for the
`401 Unauthorized` that appeared three times in one day. Ordering fixed it —
and the wait that came with it was then deleted too, because it was watching
DigitalOcean's fifteen-minute token TTL for fifteen minutes on every deploy,
after production was already serving. See the comments on the job.

A deploy is therefore GREEN in about four minutes, and the garbage collection
finishes on DigitalOcean's side some quarter of an hour later without anything
here waiting on it. `doctl registry garbage-collection list` says how it went.

If a deploy has already failed on the quota, the fix is to add the secret and
clear the space by hand — the prune runs after the build, so it cannot unblock
the run it is inside:

```bash
doctl auth init
doctl registry repository list-tags app
doctl registry repository delete-tag app <old-sha> --force
doctl registry garbage-collection start --include-untagged-manifests
```

## 5. First start

```bash
ssh deploy@<droplet-ip>
  cd /opt/mahekone
  docker compose up -d postgres     # let it initialise alone first
  docker compose logs -f postgres   # wait for "ready to accept connections"
```

Then push to `main`, or run the **Deploy** workflow by hand. It builds, pushes
the image, migrates over an SSH tunnel, and starts the app.

---

## 6. Move the data

**This is the step that has to be right.** Practise it with a copy of the data
days before the real cutover, so the only new thing on the night is the DNS
change.

```bash
# From your laptop, with the Neon connection string:
pg_dump "$NEON_URL" --no-owner --clean --if-exists | gzip -9 > mahek.sql.gz
scp mahek.sql.gz deploy@<droplet-ip>:/opt/mahekone/backups/

ssh deploy@<droplet-ip>
  cd /opt/mahekone
  bash restore.sh backups/mahek.sql.gz
```

Then check it arrived, against numbers you know:

```bash
docker compose exec postgres psql -U mahek -d mahekone -c \
  "select (select count(*) from customers) as customers,
          (select count(*) from bills) as bills,
          (select count(*) from orders) as orders,
          (select count(*) from payment_receipts) as receipts"
```

At the time of writing that should be roughly 557 customers and 10,460 bills.
Numbers materially below that mean the dump was truncated — do not continue.

Then use the app on the droplet's IP before any customer traffic reaches it:
sign in, open the accounts queue, open a customer statement, record a payment
against a bill and confirm the ledger moves.

---

## 7. Cutover

Evening IST, after the telecallers have stopped. About twenty minutes.

**There is no DNS switch in this cutover, and that makes it much safer than it
would otherwise be.** MahekOne never had a custom domain — it lived on
`*.vercel.app`. `one.mahekindia.com` is a NEW name pointing at the droplet from
the day it was created, so nothing has to be moved and nothing has to
propagate. The two systems can serve side by side, and going live is a sentence
you say to the team rather than a record you edit.

1. **Freeze writes.** Tell the team to stop, and pause the Apps Script trigger
   on the workbook (`Extensions → Apps Script → Triggers`) so no sync writes to
   Neon while you are copying.
2. **Final dump** from Neon and restore it, exactly as in step 6. Anything
   written today is in this one.
3. **Repoint the syncs.** `SYNC_URL` in the Apps Script properties, and the
   secret the nightly GitHub workflow uses — note the droplet has its own,
   newly generated `CRON_SECRET`, so both the URL *and* the secret change.
   *This is the step that gets forgotten* — a sync still pointed at Vercel
   writes orders into the abandoned Neon database, and nobody notices for days
   because both systems look fine.
4. **Unpause the trigger.** Watch one sync cycle land.
5. Sign in at `https://one.mahekindia.com`, check the certificate, and tell the
   team the new address.

### If it goes wrong

Tell everyone to use the Vercel URL again. It is still deployed, Neon is still
there, and there is no DNS to wait on — the fallback is immediate. The only
thing lost is whatever was written on the droplet in between, which is why you
cut over in the evening.

### After a week

Only once a full week has passed with nobody complaining: cancel Neon, delete
the Vercel project. Not before. The cost of keeping them a week is a few
dollars; the cost of not having them is the accounts team's month.

---

## Backups

Two, doing different jobs.

- **DigitalOcean daily backups** snapshot the whole droplet. They restore the
  *machine* — good for "the box is gone", useless for "someone deleted a row".
- **`backup.sh`** dumps the database nightly at 01:15 IST, keeps a week locally
  and a month in R2. This restores the *data*.

Install the schedule once:

```bash
ssh deploy@<droplet-ip> 'bash /opt/mahekone/backup.sh --install-cron'
```

## What the droplet runs on a schedule

The host clock is **UTC**, so the crontab is written in UTC.

| UTC | IST | What |
|---|---|---|
| `:07`, `:37` hourly | — | `sheet-sync.sh cycle` — append, taken, payments, parties, then project |
| `20:13` | 01:43 | `sheet-sync.sh nightly` — reconcile, project, then the recomputes |
| `20:45` | 02:15 | `backup.sh` — dump to R2, after the nightly has settled |

The sync used to live in GitHub Actions. `schedule:` there is best-effort: on a
private repo under a free account it delivered five or six of forty-eight
promised runs a day, in gaps of three to four hours, with every run green — so
the workbook and the CRM drifted hours apart and nothing ever reported a
problem. The workflows are still there for `workflow_dispatch`, which is how
you run a sync by hand from a browser without SSH.

### The restore drill — do this before cutover

An untested backup is a belief. Ten minutes:

```bash
ssh deploy@<droplet-ip>
  cd /opt/mahekone
  bash backup.sh                        # take one now
  docker compose exec postgres psql -U mahek -d mahekone \
    -c "create table drill as select 1 as x"   # something to lose
  bash restore.sh --list-r2
  bash restore.sh --from-r2 <the file you just made>
  docker compose exec postgres psql -U mahek -d mahekone \
    -c "select * from drill"            # must now say: relation does not exist
```

If the drill table is gone, the restore replaced the database with the dump and
your backups work. If it is still there, nothing was restored — stop and find
out why before you rely on it.

---

## Releasing the handset app

**The APK is built and published by the `MBOS APK` workflow, never from a
laptop.** Actions → MBOS APK → Run workflow, or:

```bash
gh workflow run "MBOS APK" --ref main \
  -f api_base=https://one.mahekindia.com -f publish=true
```

`workflow_dispatch` and not a push trigger, deliberately: sideloading has no
staged rollout and no rollback, so the person pressing the button is the
release. `publish: false` builds it and attaches it to the run without putting
it in front of anybody, which is how you try one before shipping it.

**`api_base` is baked into the bundle** and cannot be changed after the build,
so a build made against the wrong one is a broken binary rather than a wrong
setting. The workflow refuses anything that is not https or that ends in a
slash, before it builds.

**The signature is checked against the committed keystore in the run**, with
`apksigner` rather than `keytool -printcert -jarfile` — a modern release APK
carries no JAR signature at all, so keytool finds nothing and a check written
that way silently verifies nothing. A wrong key installs perfectly on a clean
phone and fails only on the salesman who already has the app, so this is the
step that must not be skipped.

Publishing writes to two places, answering two questions: R2 keeps every
release under a versioned name and outlives any one droplet, and the droplet
holds the single stable file `/downloads/mbos.apk` that people are given a link
to. Caddy serves that off the droplet's own disk — nothing serves `/downloads`
from R2.

**Do not build a release by hand and `scp` it up.** It skips the signature
check, the versioned archive and the record of what was shipped, and it puts
the release back on whichever laptop has a JDK — which is the situation this
workflow exists to end. Local `gradlew assembleRelease` is for trying a change
on your own phone.

## Shipping to the handset without reinstalling it

**Most changes to MBOS no longer need an APK.** `expo-updates` is wired in:
JavaScript, assets, copy and engine rules travel over the air, and a handset
picks the new bundle up in the background and runs it the next time it opens.

**It is switched OFF until somebody runs `eas init`.** `app.json` carries
`updates.enabled: false`, so `Updates.isEnabled` is false and the check returns
immediately. That is deliberate: an update channel pointed at nothing fails on
every launch, in the background, silently. `eas init` writes the project id and
the update URL, and the same step is what makes PUSH NOTIFICATIONS work —
`registerForPush` needs `extra.eas.projectId` and currently returns early
without it, which is why nine devices hold zero push tokens between them.

After `eas init`, set `updates.enabled: true`, build ONE more APK through the
`MBOS APK` workflow so the field is running a build that knows how to update
itself, and from then on:

```bash
eas update --branch production --message "what changed"
```

**What can never go over the air:** anything native — a new native module, a
permission, an Expo SDK bump, and `EXPO_PUBLIC_API_BASE`, which is inlined into
the bundle at build time. Those are an APK, always.

**`runtimeVersion` is what enforces that**, and it is the `fingerprint` policy
rather than `appVersion` on purpose. `appVersion` would read `1.0.0` — a number
this project has never bumped — so every native change would keep the same
runtime and an update would happily push JS to a build that cannot run it. A
fingerprint hashes the native project, so it changes when the native side does,
whether or not anybody remembered to.

**An update never delays a launch.** `fallbackToCacheTimeout` is 0 and the check
is not awaited: the app opens on the bundle it has, downloads the new one
behind it, and runs it next time. It deliberately does not `reloadAsync()` —
restarting the app under somebody with a half-filled order form on screen would
lose real work to deliver a cosmetic change.

**Which build a handset is running is printed on its Sync screen.** "Running the
build that was installed" means the embedded bundle; anything else names the
update. Without that, "the fix is not on my phone" and "the fix does not work"
look identical from the office.

## Day to day

```bash
docker compose ps                      # what is running
docker compose logs -f app             # the app
docker compose logs --tail=100 postgres
docker compose restart app
free -h                                # memory — the number to watch on 1 GiB
docker stats --no-stream
```

**Rolling back** is naming the previous image:

```bash
sed -i 's|^IMAGE=.*|IMAGE=registry.digitalocean.com/mahekone/app:<sha>|' .env
docker compose up -d app
```

The newest three tags are kept, plus `latest`, and whatever production is
actually on — the `prune` job in the deploy workflow enforces it after each
deploy. This used to read "old tags stay in the registry for a week", which
sounded like a policy and was only a description of what nobody had got round
to deleting; the registry filled up twice on the strength of it. Three is what
500 MB holds at ~130 MB an image, so a rollback can reach the last three
deploys and no further. A rollback that also has to
undo a migration is a different and harder thing — restore the dump.

**Jobs by hand** still work; they run on your laptop against the droplet
through a tunnel:

```bash
ssh -N -L 5433:127.0.0.1:5432 deploy@<droplet-ip> &
DATABASE_URL="postgres://mahek:<password>@127.0.0.1:5433/mahekone" \
  npx tsx --conditions=react-server scripts/run-job.ts nightly
```

---

## When to spend the extra $6

The box is 1 GiB, which is deliberate and slightly tight. Resize to 2 GiB —
one reboot, about a minute, and reversible — when any of these appear:

- swap sitting above ~500 MB rather than spiking and clearing
- the DigitalOcean memory alert firing more than occasionally
- the sheet projection or the nightly job starting to time out

Resize **RAM and CPU only**. Growing the disk is permanent and cannot be
undone.

## What you gave up

Worth remembering when something is missing rather than broken:

- **No preview deployments.** One environment, and `main` is it.
- **A few seconds of downtime per deploy** while the container swaps. Someone
  mid-save sees an error and retries.
- **Rollback is a minute, not a click.**
- **Nobody else is watching this machine.** Automatic security updates are on,
  it reboots at 03:30 if a patch needs it, and the rest is yours.
