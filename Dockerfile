ARG NODE_IMAGE=node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256 \
    HOST=0.0.0.0 \
    PORT=8900
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src
EXPOSE 8900
ENTRYPOINT ["/app/server/container-entrypoint.sh"]
CMD ["server/collector.js"]
