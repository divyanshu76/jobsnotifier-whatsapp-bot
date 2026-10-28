FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV TZ=Asia/Kolkata

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev \
    && apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node . .

RUN mkdir -p /app/auth /app/data /app/logs \
    && chown node:node /app/auth /app/data /app/logs

USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]
