# syntax=docker/dockerfile:1.27

ARG DEPLOYMENT_BUILD_ID="local"

ARG NODE_VERSION

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG APPLICATION_PACKAGE_NAME
ARG DATABASE_PACKAGE_NAME
ARG MIGRATION_PACKAGE_NAME
# @template-mirror pnpm-bootstrap
COPY --from=ghcr.io/pnpm/pnpm:__PNPM_VERSION__ /opt/pnpm /opt/pnpm
# @end-template-mirror
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/pnpm" "/usr/local/bin/$bin"; done
WORKDIR /repo
COPY package.json ./

FROM base AS pruner
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
# Frozen install validates all importers; the full context also preserves declarations from added packages.
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm exec turbo prune "$APPLICATION_PACKAGE_NAME" "$MIGRATION_PACKAGE_NAME" --docker

FROM base AS build
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
COPY --from=pruner /repo/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
RUN pnpm --filter "$DATABASE_PACKAGE_NAME" run build
RUN pnpm --filter "$APPLICATION_PACKAGE_NAME" run build
RUN pnpm --config.inject-workspace-packages=true --filter "$APPLICATION_PACKAGE_NAME" deploy --prod /runtime-deploy
RUN pnpm --config.inject-workspace-packages=true --filter "$MIGRATION_PACKAGE_NAME" deploy --prod /migration-deploy

FROM node:${NODE_VERSION}-bookworm-slim AS application-runtime
ARG APPLICATION_PACKAGE_PATH
ENV NODE_ENV="production"
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin app \
  && install -d -o app -g nodejs /app /data
COPY --from=build --chown=app:nodejs /runtime-deploy/node_modules ./node_modules
COPY --from=build --chown=app:nodejs /repo/${APPLICATION_PACKAGE_PATH}/dist ./dist
ENV DATABASE_FILE="/data/app.sqlite"
USER app

# Single-container deployment prepares the database before starting the application.
FROM application-runtime AS standalone
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
ENV PATH="/migration/node_modules/.bin:$PATH"
COPY --from=build --chown=app:nodejs /migration-deploy /migration
COPY --chmod=755 --from=build /repo/scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
CMD ["prepare-and-start"]

# Starts only the application; the database must be prepared beforehand by the matching standalone image.
FROM application-runtime AS runtime
ARG DEPLOYMENT_BUILD_ID
LABEL org.opencontainers.image.version="$DEPLOYMENT_BUILD_ID"
EXPOSE 3000
CMD ["node", "/app/dist/server/index.mjs"]
