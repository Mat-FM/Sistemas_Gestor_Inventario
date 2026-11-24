#!/usr/bin/env bash
# Registra cada 5 s la CPU y la memoria de los contenedores de la pila en results/recursos.csv (la guía del taller pide registrar el CPU y
# la RAM del servidor). resumen.py anota el máximo de cada contenedor en RESULTADOS.md.
#
# Uso, en otra terminal mientras corren las pruebas (Ctrl+C para detenerlo):
#   ./recursos.sh              # contenedores del proyecto gi-prueba (la pila de smoke-tests)
#   ./recursos.sh <proyecto>   # los de otro proyecto de docker compose
set -euo pipefail
PROYECTO="${1:-gi-prueba}"
DESTINO="$(cd "$(dirname "$0")" && pwd)/results/recursos.csv"
mkdir -p "$(dirname "$DESTINO")"
[ -f "$DESTINO" ] || echo "momento,contenedor,cpu,memoria" > "$DESTINO"
echo "Registrando en $DESTINO los contenedores de «${PROYECTO}» cada 5 s (Ctrl+C para terminar)"
while true; do
  momento="$(date +%Y-%m-%dT%H:%M:%S)"
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' \
    | grep "^${PROYECTO}-" | sed "s|^|${momento},|" >> "$DESTINO" || true
  sleep 5
done
