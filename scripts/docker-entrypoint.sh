#!/bin/sh
# Entrypoint dedicado: roda migrations antes de exec do CMD.
# `exec` substitui o shell pelo Node, mantendo PID 1 sob o tini, que
# propaga SIGTERM corretamente para o handler de shutdown.

set -e

echo "[entrypoint] Aplicando migracoes Prisma..."
npx prisma migrate deploy

echo "[entrypoint] Iniciando processo: $@"
exec "$@"
