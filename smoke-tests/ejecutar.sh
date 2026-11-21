#!/usr/bin/env bash
# Levanta TODO el sistema con docker compose en un proyecto aparte (gi-prueba, puertos 18100 en adelante, solo en 127.0.0.1),
# corre las pruebas de funcionamiento y lo apaga. No usa ni toca tu .env ni tus contenedores.
#
#   ./smoke-tests/ejecutar.sh               # construye, levanta, prueba y borra todo (contenedores, volúmenes y secretos temporales)
#   ./smoke-tests/ejecutar.sh --conservar   # igual, pero deja la pila arriba para probar a mano (la dirección sale al final)
#   ./smoke-tests/ejecutar.sh --sin-limites # omite las pruebas de límite de peticiones (gastan el cupo del minuto)
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
CONSERVAR=0; EXTRA=()
for a in "$@"; do case "$a" in --conservar) CONSERVAR=1 ;; *) EXTRA+=("$a") ;; esac; done

PUERTOS=(18100 18101 18102 18103 18104 18110 18111 18112 18113 18114 18115 18116)
for p in "${PUERTOS[@]}"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "El puerto $p está ocupado: cierra lo que lo usa o cambia los puertos de este script." >&2; exit 2; fi
done

TMP="$(mktemp -d)"; ENV="$TMP/prueba.env"; chmod 700 "$TMP"
DC=(docker compose -p gi-prueba --env-file "$ENV")
limpiar() {
  if [ "$CONSERVAR" = 0 ]; then "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; fi
}
trap limpiar EXIT

secreto() { openssl rand -hex 12; }
llave() { echo "base64:$(openssl rand -base64 32)"; }
{
  for s in GATEWAY:gateway CATALOGO:catalogo PROVEEDORES:proveedores INVENTARIO:inventario COMPRAS:compras NOTIFICACIONES:notificaciones REPORTES:reportes; do
    N="${s%%:*}"; n="${s##*:}"
    echo "${N}_DB_NAME=${n}_db"; echo "${N}_DB_USER=${n}"; echo "${N}_DB_PASSWORD=$(secreto)"
  done
  echo "GATEWAY_DB_PORT=18110"; echo "CATALOGO_DB_PORT=18111"; echo "PROVEEDORES_DB_PORT=18112"; echo "INVENTARIO_DB_PORT=18113"
  echo "COMPRAS_DB_PORT=18114"; echo "NOTIFICACIONES_DB_PORT=18115"; echo "REPORTES_DB_PORT=18116"
  echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
  echo "GATEWAY_APP_KEY=$(llave)"; echo "CATALOGO_APP_KEY=$(llave)"; echo "PROVEEDORES_APP_KEY=$(llave)"; echo "WEB_APP_KEY=$(llave)"
  echo "ADMIN_EMAIL=admin@prueba.test"; echo "ADMIN_PASSWORD=ClavePrueba2026"
  # Opcionales: súbelos para medir el rendimiento del Gateway (performance-tests/brayan-collazos); con los de siempre se mediría el límite.
  echo "GATEWAY_RATE_LIMIT_PER_MINUTE=${GATEWAY_RATE_LIMIT_PER_MINUTE:-100}"; echo "GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE=${GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE:-10}"
  echo "GATEWAY_PORT=18100"; echo "WEB_PORT=18101"; echo "INVENTARIO_PORT=18102"; echo "COMPRAS_PORT=18103"; echo "NOTIFICACIONES_PORT=18104"
} > "$ENV"
chmod 600 "$ENV"

echo "Construyendo las imágenes, una por una (en paralelo cuelga Docker Desktop)..."
for s in api-gateway ms-catalogo ms-proveedores ms-inventario ms-compras ms-notificaciones ms-reportes web-client; do
  echo "  - $s"; "${DC[@]}" build "$s" >"$TMP/build-$s.log" 2>&1 || { echo "Falló la construcción de $s:" >&2; tail -20 "$TMP/build-$s.log" >&2; exit 1; }
done

echo "Levantando la pila..."
"${DC[@]}" up -d >"$TMP/up.log" 2>&1 || { cat "$TMP/up.log" >&2; exit 1; }
for _ in $(seq 1 90); do
  g=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18100/health || true)
  w=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18101/login || true)
  [ "$g" = 200 ] && [ "$w" = 200 ] && break; sleep 2
done
[ "$g" = 200 ] && [ "$w" = 200 ] || { echo "La pila no quedó lista (Gateway $g, cliente web $w)." >&2; "${DC[@]}" ps -a >&2; exit 1; }
"${DC[@]}" ps -a --format 'table {{.Service}}\t{{.Status}}' | grep -v migraciones

set +e
python3 "$RAIZ/smoke-tests/verificar_sistema.py" --gateway http://127.0.0.1:18100 --web http://127.0.0.1:18101 \
  --admin-correo admin@prueba.test --admin-clave ClavePrueba2026 --compose "docker compose -p gi-prueba --env-file $ENV" ${EXTRA[@]+"${EXTRA[@]}"}
RESULTADO=$?
set -e
if [ "$CONSERVAR" = 1 ]; then
  echo; echo "Pila conservada. Cliente web: http://127.0.0.1:18101 · Gateway: http://127.0.0.1:18100 (admin@prueba.test / ClaveNueva2026A)"
  echo "Para apagarla: docker compose -p gi-prueba --env-file $ENV down -v   (y borra $TMP)"
fi
exit $RESULTADO
