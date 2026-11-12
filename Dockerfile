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
# Docker's official images, pulled through AWS's public mirror of them rather
# than Docker Hub: GitHub's runners share IPs, and Docker Hub's anonymous pull
# limit failed every CI job and deploy that landed on a throttled one. Same
# image, same tags — only where it is fetched from. CI and the deploy pass
# NODE_IMAGE when the mirror is refusing (.github/actions/node-image), and
# Docker Hub's copy of the same image stands in for it.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually
# changes rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS builder
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

# Type-checked elsewhere, before anything deploys: see `typescript` in
# next.config.ts. Here it would only make the push wait 71 seconds for an
# answer the deploy's `test` job is already giving.
ENV NEXT_BUILD_SKIP_TYPECHECK=1

# The docs index is built, not committed (see .gitignore): it cuts the code the
# documentation quotes out of THIS source. `npx next build` skips npm's
# `prebuild` hook, so it is run by name rather than relied on.
# THE SAME KEY EVERY BUILD, so a deploy stops breaking the saves in every open
# tab. Next salts each Server Action's id with this key and, left unset, makes
# up a fresh random one per build — so EVERY action id changed on EVERY deploy,
# including the ones whose code did not, and every tab open across it had its
# next save refused ("Server Action … was not found"). Fixed, an id changes only
# when its own file does. A build SECRET rather than an ARG: an ARG is written
# into the image history for anybody holding the image to read. Optional — a
# build without it falls back to Next's random key and still works, it just
# breaks open tabs again (see src/lib/version-skew.ts).
RUN --mount=type=secret,id=actions_key \
    if [ -s /run/secrets/actions_key ]; then \
      export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/actions_key)"; \
    else \
      echo "warning: no actions_key secret; Server Action ids will change on every deploy" >&2; \
    fi \
    && node scripts/docs-index.mjs && npx next build

# ------------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runner
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

# SHARP SHIPS NOW, AND THAT REVERSES THE REMOVAL THAT USED TO BE HERE. It
# was deleted from the runtime image as 18 MB kept only for an image optimiser
# that is switched off — true, and still true of the optimiser. What changed is
# the Studio: its poster renderer IS sharp (libvips and Pango drawing Hindi and
# Gujarati text onto a design), so the binaries are the app's own dependency
# now, traced in by `src/lib/studio/renderer` rather than copied in by Next.
# The optimiser stays off; `images.unoptimized` in next.config.ts still says
# why.
#
# The Studio's designs and fonts are read from disk by path, which no file
# trace can see, so they are copied beside server.js by hand. fontconfig gives
# Pango the configuration file it looks for; the fonts themselves are always
# named by file, never found on the system.
RUN apk add --no-cache fontconfig
COPY --from=builder --chown=nextjs:nodejs /app/studio ./studio

# A render that cannot draw Indic text must fail the BUILD, not the first
# person to make a Hindi poster. This draws one line in each script with the
# fonts the designs use and refuses an empty result.
RUN node -e "const s=require('sharp');const f='/app/studio/assets/fonts/';Promise.all([['Noto Sans','NotoSans-Regular.ttf','Mahek'],['Noto Sans Devanagari','NotoSansDevanagari-Regular.ttf','शुभ दीपावली'],['Noto Sans Gujarati','NotoSansGujarati-Regular.ttf','શુભ દિવાળી']].map(([n,file,t])=>s({text:{text:t,font:n+' 40',fontfile:f+file}}).png().toBuffer({resolveWithObject:true}).then(r=>{if(r.info.width<40)throw new Error(n+' drew nothing');}))).then(()=>console.log('studio: text renders')).catch(e=>{console.error(e);process.exit(1);})"

USER nextjs
EXPOSE 3000

# Caddy is the only thing that talks to this, over the compose network. The
# port is never published to the host.
CMD ["node", "server.js"]
