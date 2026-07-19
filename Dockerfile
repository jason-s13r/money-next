# syntax=docker/dockerfile:1

# Node 24 on Debian bookworm — glibc, deliberately NOT Alpine/musl.
# `@gorules/zen-engine` is a napi-rs native addon whose prebuilds are glibc; musl
# is where that burns an afternoon (see docs/multi-user.md). 24 matches .nvmrc
# rather than the doc's "22" — the glibc point is what mattered, not the major.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# bookworm-slim ships no OpenSSL; Prisma's schema engine (migrate deploy) needs
# libssl or it falls back to a guessed version and "may not work as expected".
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---- deps: full install (incl. dev deps), run INSIDE the linux image so the
# linux zen-engine prebuild is fetched — pnpm only installs the optional
# platform package for the current OS, and the host is likely darwin. ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# postinstall runs `prisma generate`, which needs the schema and resolves
# `env("DATABASE_URL")` in prisma.config.ts at load — a placeholder satisfies it,
# generate is offline and never connects. The real URL arrives at runtime.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: `next build` with standalone output. Also the tooling image reused
# by the migrate and cron services — it carries the TS source, tsx and the
# Prisma CLI, none of which the minimal runner ships. ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Placeholders satisfy `env("DATABASE_URL")` in prisma.config.ts and the
# import-time guards in lib/server/db and lib/server/auth that `next build` trips
# while tracing server modules. Rendering is dynamic (every route reads `ƒ`), so
# nothing here connects to a database or is baked into the output — the real
# values arrive at runtime from the environment.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV BETTER_AUTH_SECRET="build-only-not-used-at-runtime"
ENV BETTER_AUTH_URL="http://localhost:3000"
ENV NEXT_TELEMETRY_DISABLED=1
# The client is generated into lib/generated/prisma and is not in git.
RUN pnpm prisma generate
RUN pnpm build

# ---- runner: the minimal standalone app image. No source, no Prisma CLI, no
# tsx — migrations and the cron sync run on the `build` image instead. ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# standalone traces a minimal server + only the node_modules it reaches. It does
# NOT copy public/ or .next/static — those are copied in by hand here.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Run unprivileged; the `node` base image ships a `node` user. Nothing is written
# to the filesystem at runtime, so read access to root-owned files is enough.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
