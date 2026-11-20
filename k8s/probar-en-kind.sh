#!/usr/bin/env bash
# Despliega TODO el sistema en un clúster local de kind (Kubernetes dentro de Docker), lo prueba y lo borra:
#   1. construye las ocho imágenes (de una en una) y las carga en el clúster;
#   2. instala el controlador de Ingress (ingress-nginx) y metrics-server, que el autoescalado necesita;
#   3. crea los Secret con valores al azar, aplica k8s/, espera las migraciones y siembra al administrador;
#   4. comprueba el Ingress, las NetworkPolicy y las 53 pruebas de funcionamiento (smoke-tests/verificar_sistema.py --k8s);
#   5. genera carga y comprueba que el Gateway y ms-inventario pasan de 1 a 4 copias (RNF05), salvo con --sin-carga.
#
#   ./k8s/probar-en-kind.sh                 # todo, y al final borra el clúster
#   ./k8s/probar-en-kind.sh --conservar     # deja el clúster arriba (contexto kubectl: kind-gi-prueba)
#   ./k8s/probar-en-kind.sh --sin-carga     # omite la prueba de autoescalado (unos 6 minutos)
#
# Necesita Docker, kind, kubectl, curl y Python 3. El clúster usa puertos solo en 127.0.0.1 (Ingress en el 18180) y un contexto propio:
# no toca tus otros clústeres ni contenedores. Las bases (mysql:8.4 y postgres:16) las descarga el propio clúster.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"; cd "$RAIZ"
CONSERVAR=0; CARGA=1
for a in "$@"; do case "$a" in --conservar) CONSERVAR=1 ;; --sin-carga) CARGA=0 ;; *) echo "Opción desconocida: $a" >&2; exit 2 ;; esac; done
for h in docker kind kubectl curl python3; do command -v "$h" >/dev/null || { echo "Falta $h." >&2; exit 2; }; done
for p in 18180 18143 18200 18201; do lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && { echo "El puerto $p está ocupado." >&2; exit 2; }; done

CLUSTER=gi-prueba; NS=gestor-inventario; TMP="$(cd "$(mktemp -d)" && pwd -P)"; PF=()   # ruta real (sin enlaces): kustomize resuelve la ruta relativa desde ahí
INGRESS_NGINX=https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/kind/deploy.yaml
METRICS_SERVER=https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.1/components.yaml
limpiar() {
  for p in "${PF[@]+"${PF[@]}"}"; do kill "$p" 2>/dev/null || true; done
  if [ "$CONSERVAR" = 0 ]; then kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; rm -rf "$TMP"; else echo "Clúster conservado: kubectl --context kind-$CLUSTER -n $NS get pods (borrarlo: kind delete cluster --name $CLUSTER)"; fi
}
trap limpiar EXIT
paso() { echo; echo "== $*"; }
fallos=0
verificar() { # descripción, comando...
  local d="$1"; shift; if "$@" >/dev/null 2>&1; then echo "  ✔ $d"; else echo "  ✘ $d"; fallos=$((fallos+1)); fi
}

paso "1. Imágenes"
kind get clusters 2>/dev/null | grep -qx "$CLUSTER" && { echo "Ya existe un clúster $CLUSTER: bórralo con «kind delete cluster --name $CLUSTER»." >&2; exit 2; }
for s in api-gateway services/ms-catalogo services/ms-proveedores services/ms-inventario services/ms-compras services/ms-notificaciones services/ms-reportes web-client; do
  n="${s##*/}"; echo "  - $n"; docker build -q -t "$n:latest" "$s" >/dev/null
done

paso "2. Clúster de kind y complementos"
cat > "$TMP/kind.yaml" <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - { containerPort: 80, hostPort: 18180, listenAddress: "127.0.0.1", protocol: TCP }
      - { containerPort: 443, hostPort: 18143, listenAddress: "127.0.0.1", protocol: TCP }
YAML
kind create cluster --name "$CLUSTER" --config "$TMP/kind.yaml" >/dev/null
K="kubectl --context kind-$CLUSTER"
for n in api-gateway ms-catalogo ms-proveedores ms-inventario ms-compras ms-notificaciones ms-reportes web-client; do kind load docker-image "$n:latest" --name "$CLUSTER" >/dev/null; done
$K apply -f "$INGRESS_NGINX" >/dev/null
curl -sfL "$METRICS_SERVER" | sed 's|        - --metric-resolution=15s|        - --metric-resolution=15s\n        - --kubelet-insecure-tls|' | $K apply -f - >/dev/null   # kind firma los kubelet con su propia CA
$K -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=300s >/dev/null
$K -n kube-system rollout status deploy/metrics-server --timeout=300s >/dev/null

paso "3. Despliegue de k8s/"
$K apply -f k8s/base/namespace.yaml >/dev/null
KN="$K -n $NS"
for bd in api-gateway:gateway ms-catalogo:catalogo ms-proveedores:proveedores ms-inventario:inventario ms-compras:compras ms-notificaciones:notificaciones ms-reportes:reportes; do
  $KN create secret generic "db-${bd%%:*}" --from-literal=nombre="${bd##*:}_db" --from-literal=usuario="${bd##*:}" --from-literal=clave="$(openssl rand -hex 16)" >/dev/null
done
$KN create secret generic api-gateway-app --from-literal=APP_KEY="base64:$(openssl rand -base64 32)" --from-literal=JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')" >/dev/null
for s in ms-catalogo ms-proveedores web-client; do $KN create secret generic "$s-app" --from-literal=APP_KEY="base64:$(openssl rand -base64 32)" >/dev/null; done
$KN create secret generic api-gateway-admin --from-literal=ADMIN_EMAIL=admin@prueba.test --from-literal=ADMIN_PASSWORD=ClavePrueba2026 >/dev/null
# Capa de prueba (no toca el repositorio): confía en los pods como proxies (la red de pods de kind es 10.244.0.0/16).
mkdir -p "$TMP/capa"
cat > "$TMP/capa/kustomization.yaml" <<YAML
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - $(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$RAIZ/k8s" "$TMP/capa")
patches:
  - target: {kind: ConfigMap, name: api-gateway-config}
    patch: |-
      - {op: replace, path: /data/TRUSTED_PROXIES, value: "10.244.0.0/16"}
  - target: {kind: ConfigMap, name: web-client-config}
    patch: |-
      - {op: replace, path: /data/TRUSTED_PROXIES, value: "10.244.0.0/16"}
YAML
$K apply -k "$TMP/capa" >/dev/null
for j in api-gateway ms-catalogo ms-proveedores ms-inventario ms-reportes; do $KN wait --for=condition=complete "job/$j-migrar" --timeout=300s >/dev/null; done
$KN apply -f k8s/base/sembrar-administrador.yaml >/dev/null
$KN wait --for=condition=complete job/api-gateway-sembrar --timeout=200s >/dev/null
$KN delete job/api-gateway-sembrar secret/api-gateway-admin >/dev/null
$KN rollout status deploy --timeout=300s >/dev/null
$KN get pods --no-headers | awk '$3!="Completed"{print "  "$1, $2, $3, "reinicios="$4}'

paso "4. Ingress y NetworkPolicy"
verificar "Ingress: el Gateway responde en api.inventario.ejemplo.com" curl -sf -H 'Host: api.inventario.ejemplo.com' http://127.0.0.1:18180/health
verificar "Ingress: el cliente web responde en inventario.ejemplo.com" curl -sf -H 'Host: inventario.ejemplo.com' http://127.0.0.1:18180/login
verificar "Ingress: un dominio desconocido no llega a ningún servicio (404)" test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: otro.ejemplo.com' http://127.0.0.1:18180/health)" = 404
alcanza() { # etiquetas destino puerto -> 0 si conecta
  $KN run "np-$RANDOM" --image=busybox:1.36 --restart=Never --rm -i --quiet ${1:+--labels="$1"} --command -- sh -c "nc -z -w3 $2 $3" >/dev/null 2>&1; }
if alcanza "" ms-inventario 3000; then echo "  ✘ un pod sin etiquetas llegó a ms-inventario"; fallos=$((fallos+1)); else echo "  ✔ un pod sin permiso no llega a ms-inventario"; fi
if alcanza "" db-ms-inventario 5432; then echo "  ✘ un pod sin etiquetas llegó a la base de inventario"; fallos=$((fallos+1)); else echo "  ✔ un pod sin permiso no llega a la base de inventario"; fi
if alcanza "app.kubernetes.io/name=api-gateway" db-ms-inventario 5432; then echo "  ✘ el Gateway llegó a la base de inventario (RNF02)"; fallos=$((fallos+1)); else echo "  ✔ el Gateway no llega a la base de inventario (RNF02)"; fi
if alcanza "app.kubernetes.io/name=api-gateway" ms-inventario 3000; then echo "  ✔ el Gateway sí llega a ms-inventario"; else echo "  ✘ el Gateway no llegó a ms-inventario"; fallos=$((fallos+1)); fi
if alcanza "app.kubernetes.io/name=ms-inventario,db=db-ms-inventario" db-ms-inventario 5432; then echo "  ✔ ms-inventario sí llega a su base de datos"; else echo "  ✘ ms-inventario no llegó a su base"; fallos=$((fallos+1)); fi

paso "5. Pruebas de funcionamiento (53)"
$KN port-forward --address 127.0.0.1 svc/api-gateway 18200:8000 >/dev/null 2>&1 & PF+=($!)
$KN port-forward --address 127.0.0.1 svc/web-client 18201:8000 >/dev/null 2>&1 & PF+=($!)
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:18200/health >/dev/null && curl -sf http://127.0.0.1:18201/login >/dev/null && break; sleep 1; done
kubectl config use-context "kind-$CLUSTER" >/dev/null
set +e
python3 smoke-tests/verificar_sistema.py --gateway http://127.0.0.1:18200 --web http://127.0.0.1:18201 --admin-correo admin@prueba.test --admin-clave ClavePrueba2026 --k8s "$NS" | grep -E "✘|^[0-9]+ de"
[ "${PIPESTATUS[0]}" = 0 ] || fallos=$((fallos+1))
set -e

if [ "$CARGA" = 1 ]; then
  paso "6. Autoescalado (RNF05): carga desde dentro del clúster durante 4 minutos"
  for i in 1 2 3 4 5 6; do
    $KN run "carga-gw-$i" --image=busybox:1.36 --restart=Never --labels="app.kubernetes.io/name=web-client,prueba=carga" --command -- sh -c 'f=$(( $(date +%s)+240 )); while [ $(date +%s) -lt $f ]; do wget -q -O /dev/null http://api-gateway:8000/health; done' >/dev/null
    $KN run "carga-inv-$i" --image=busybox:1.36 --restart=Never --labels="app.kubernetes.io/name=api-gateway,prueba=carga" --command -- sh -c 'f=$(( $(date +%s)+240 )); while [ $(date +%s) -lt $f ]; do wget -q -O /dev/null --header "X-User-Id: 1" --header "X-User-Rol: ADMINISTRADOR" "http://ms-inventario:3000/saldos?por_pagina=100"; done' >/dev/null
  done
  maximo_gw=1; maximo_inv=1
  for _ in $(seq 1 10); do
    sleep 30
    g=$($KN get deploy api-gateway -o jsonpath='{.status.replicas}'); i=$($KN get deploy ms-inventario -o jsonpath='{.status.replicas}')
    [ "$g" -gt "$maximo_gw" ] && maximo_gw=$g; [ "$i" -gt "$maximo_inv" ] && maximo_inv=$i
    echo "  copias ahora: api-gateway=$g ms-inventario=$i"
  done
  $KN delete pod -l prueba=carga --wait=false >/dev/null
  if [ "$maximo_gw" -gt 1 ]; then echo "  ✔ el Gateway escaló de 1 a $maximo_gw copias"; else echo "  ✘ el Gateway no escaló"; fallos=$((fallos+1)); fi
  if [ "$maximo_inv" -gt 1 ]; then echo "  ✔ ms-inventario escaló de 1 a $maximo_inv copias"; else echo "  ✘ ms-inventario no escaló"; fallos=$((fallos+1)); fi
fi

echo; if [ "$fallos" = 0 ]; then echo "Todo en orden: Kubernetes funciona."; else echo "$fallos comprobaciones fallaron."; fi
exit $((fallos > 0))
