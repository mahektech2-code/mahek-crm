# MahekOne, as one image.
#
# Built on GitHub's runners and never on the droplet: `next build` runs `tsc`
# over the whole codebase and wants more memory than a 1 GiB box has to spare.
# The droplet only ever pulls a finished image.
#
# Three stages so the runtime layer carries no toolchain and no source. What
# ships is the standalone server Next emits, its static assets, and nothing
# else, which matters because the free container registry holds 500 MB and we
# keep a few tags for rolling back. The runtime stage also deletes the image
# optimiser's binaries, which Next ships whether or not anything uses them —
# see the note beside that line.

# --------------------------------------------------------------- dependencies
FROM node:24-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually
# changes rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------------- build
FROM node:24-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Which commit this image is, baked in as Next's own version-skew guard —
# see `deploymentId` in next.config.ts. Passed by the workflow as the same
# sha the image is tagged with, so a browser tab left open across a deploy
# gets a full reload instead of a Server Action failing with "was not found
# on the server": the client compares this against what the new server
# reports and reloads itself rather than surfacing the mismatch as an error.
ARG GIT_SHA
ENV NEXT_DEPLOYMENT_ID=${GIT_SHA}

# The build must not reach for a database. `npm run build` used to run
# `db:deploy` and `catalogue:deploy` first, which worked on Vercel because the
# build ran next to the database; here it runs on a GitHub runner with no route
# to Postgres at all. Both now happen at deploy time over an SSH tunnel — see
# .github/workflows/deploy.yml — so the image is a pure function of the source.
ENV NEXT_TELEMETRY_DISABLED=1

# A DATABASE_URL THAT GOES NOWHERE, because the build needs the variable to
# exist and must never have a real one.
#
# `src/db/index.ts` throws at IMPORT time when DATABASE_URL is unset — which is
# right, and which is exactly why the build fails here and nowhere else. Next
# imports every route to collect page data, so `/api/accounts/queue-detail`
# loads the db module, the module throws, and the build stops. On a developer's
# laptop and in CI this never happens, because both have a database sitting
# there; the Docker build is the only place the variable is genuinely absent.
#
# Nothing connects. Every route in this app is dynamic (`ƒ` in the build
# output), so no page fetches data at build time — the module is imported and
# its pool is constructed lazily, never dialled. The host is spelled to be
# unresolvable rather than plausible: if this value ever DOES reach a
# connection attempt, it must fail loudly instead of quietly finding something.
ENV DATABASE_URL=postgres://build:build@build-time-no-database.invalid:5432/build

RUN npx next build

# ------------------------------------------------------------------- runtime
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Not root. A web process that is compromised should not also own the
# filesystem it is running on.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

# `output: "standalone"` traces exactly the files the server needs and copies
# them here — node_modules included, pruned to what is actually imported.
# Static assets and `public/` sit outside that trace and are copied by hand.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# THE IMAGE OPTIMISER'S BINARIES, WHICH NOTHING HERE ASKS FOR.
#
# `next/image` is imported nowhere in this app and `images.unoptimized` is set,
# so the resizing endpoint does not exist — see the note in next.config.ts for
# why the one `<img>` this product renders is a plain tag pointing at
# `/api/attachments/[id]`.
#
# Next copies `sharp` and its platform libvips build into `standalone` anyway,
# OUTSIDE the file trace: `images.unoptimized` does not stop it and neither
# does `outputFileTracingExcludes` — both were tried and the directory survived
# both. So it is removed here, where it is visible to whoever reads the
# Dockerfile, rather than hidden behind a config flag that does not do it.
#
# 18.3 MB of a 62 MB application layer, for an optimiser with nothing to
# optimise. The registry this pushes to holds 500 MB in total and keeps several
# tags for rolling back — deploys have already failed on that quota, so this is
# a constraint rather than tidiness.
#
# VERIFIED, not assumed: the standalone server was started with these removed
# and serves `/login` at 200 with nothing in its log. If it were needed it
# would fail at the first request to the optimiser, and no request reaches an
# optimiser that is switched off.
RUN rm -rf ./node_modules/@img ./node_modules/sharp

USER nextjs
EXPOSE 3000

# Caddy is the only thing that talks to this, over the compose network. The
# port is never published to the host.
CMD ["node", "server.js"]
