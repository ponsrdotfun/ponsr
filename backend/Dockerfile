# Two stages, because better-sqlite3 is a native module.
#
# It compiles against the Node ABI at install time, so it needs python3, make and a C++
# toolchain -- none of which should survive into the image that faces the internet. The build
# stage compiles it; the runtime stage copies the result and keeps no compiler.
FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy manifests alone first. Docker caches this layer on the lockfile's hash, so editing
# source does not recompile the native module -- that recompile is most of the build time.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies in place. The compiled .node binary is preserved because
# better-sqlite3 is a production dependency; only the toolchain and typescript go.
RUN npm prune --omit=dev


FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user. The image ships one (`node`, uid 1000); the volume is chowned to it
# in the same layer that creates the mount point, since a root-owned mount point would leave
# the database unwritable in a way that only appears at boot.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

# Matches fly.toml's mount and PORT. Both are set again there, deliberately: this image should
# behave identically if it is ever run somewhere that is not Fly.
ENV DATABASE_PATH=/data/bot.sqlite
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
