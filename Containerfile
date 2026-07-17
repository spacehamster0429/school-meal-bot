FROM docker.io/library/node:24-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev \
  && npm cache clean --force \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM docker.io/library/node:24-bookworm-slim

ENV NODE_ENV=production
ENV DB_PATH=/data/users.db
ENV HEALTH_HOST=127.0.0.1
ENV HEALTH_PORT=3032

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY LICENSE NOTICE ./
COPY index.js neis.js database.js deploy-commands.js health-server.js ./

RUN mkdir -p /data \
  && chown -R node:node /app /data

USER node

EXPOSE 3032

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3032/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
