# syntax=docker/dockerfile:1.27

ARG DEPLOYMENT_BUILD_ID="local"

FROM node:26.13.1-bookworm-slim AS base
ARG APPLICATION_PACKAGE_NAME
ARG DATABASE_PACKAGE_NAME
ARG MIGRATION_PACKAGE_NAME
COPY --from=ghcr.io/pnpm/pnpm:12.21.0 /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/pnpm" "/usr/local/bin/$bin"; done
WORKDIR /repo
COPY package.json ./

FROM base AS pruner
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch
# Frozen install validates all importers; the full context also preserves declarations from added packages.
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm exec turbo prune "$APPLICATION_PACKAGE_NAME" "$MIGRATION_PACKAGE_NAME" --docker

FROM base AS build
ARG ENTRYPOINT_SCRIPT_PATH="scripts/container-entrypoint.sh"
COPY --from=pruner /repo/out/json/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/json/pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch
COPY --from=pruner /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --offline --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
COPY --from=pruner /repo/${ENTRYPOINT_SCRIPT_PATH} ./scripts/container-entrypoint.sh
RUN pnpm exec turbo run build --filter="$APPLICATION_PACKAGE_NAME" --filter="$MIGRATION_PACKAGE_NAME"
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm --config.inject-workspace-packages=true --filter "$APPLICATION_PACKAGE_NAME" deploy --prod /runtime-deploy
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm --config.inject-workspace-packages=true --filter "$MIGRATION_PACKAGE_NAME" deploy --prod /migration-deploy

FROM node:26.13.1-bookworm-slim AS application-runtime
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
