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

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY index.js neis.js database.js deploy-commands.js ./

RUN mkdir -p /data \
  && chown -R node:node /app /data

USER node

CMD ["node", "index.js"]
