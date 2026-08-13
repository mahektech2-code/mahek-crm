# MahekOne, as one image.
#
# Built on GitHub's runners and never on the droplet: `next build` runs `tsc`
# over the whole codebase and wants more memory than a 1 GiB box has to spare.
# The droplet only ever pulls a finished image.
#
# Three stages so the runtime layer carries no toolchain and no source. What
# ships is the standalone server Next emits, its static assets, and nothing
# else — around 200 MB, which matters because the free container registry
# holds 500 MB and we keep a few tags for rolling back.

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

# The build must not reach for a database. `npm run build` used to run
# `db:deploy` and `catalogue:deploy` first, which worked on Vercel because the
# build ran next to the database; here it runs on a GitHub runner with no route
# to Postgres at all. Both now happen at deploy time over an SSH tunnel — see
# .github/workflows/deploy.yml — so the image is a pure function of the source.
ENV NEXT_TELEMETRY_DISABLED=1
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

USER nextjs
EXPOSE 3000

# Caddy is the only thing that talks to this, over the compose network. The
# port is never published to the host.
CMD ["node", "server.js"]
