FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-slim

WORKDIR /app

# openssl: requerido pelo Prisma. tini: PID 1 que propaga SIGTERM
# corretamente para o processo Node. Sem isso, `docker stop` espera o
# grace period (10s) e mata forcado, sem rodar nosso shutdown handler.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

RUN mkdir -p /app/auth_info_baileys /app/data

# Healthcheck: confere que o processo respondeu pelo menos uma vez no
# arquivo de heartbeat escrito pelo logger. Conexao WhatsApp e
# verificada de forma indireta — se o processo trava, o heartbeat para.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "const fs=require('fs'); const s=fs.statSync('/app/data/heartbeat'); if (Date.now()-s.mtimeMs>120000) process.exit(1);" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
