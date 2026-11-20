# Kubernetes (RNF04)

Manifiestos del sistema completo con **kustomize** (`kubectl kustomize` ya viene con `kubectl`; no hace falta instalar nada más).

> **Estado:** además de la revisión estática (`kubectl kustomize` y `k8s/verificar.py`, que corre en la CI), los manifiestos **se
> desplegaron y probaron en un clúster local de kind** con `k8s/probar-en-kind.sh`: arranque sin reinicios, migraciones, Ingress,
> NetworkPolicy (las bases solo las alcanza su servicio, RNF02), autoescalado del Gateway y de `ms-inventario` de 1 a 4 copias bajo carga
> (RNF05), persistencia de las bases al reiniciar sus Pods y las 53 pruebas de funcionamiento de `smoke-tests/`. Esas pruebas
> encontraron y corrigieron dos defectos: el contenedor que espera a la base de las migraciones corría como root y `runAsNonRoot` lo
> rechazaba, y `ms-compras` y `ms-notificaciones` se reiniciaban al arrancar antes que su base. **No se probó** en un clúster real
> (nube, varios nodos) ni con HTTPS.

## Probarlo en un clúster local

```bash
brew install kind                 # una vez; también hace falta kubectl y Docker
./k8s/probar-en-kind.sh           # construye, despliega, prueba y borra el clúster (unos 15 minutos)
./k8s/probar-en-kind.sh --conservar --sin-carga   # lo deja arriba y omite la prueba de autoescalado
```

Crea un clúster `gi-prueba` (contexto `kind-gi-prueba`, Ingress solo en `127.0.0.1:18180`), instala `ingress-nginx` y `metrics-server`
(con `--kubelet-insecure-tls`, porque kind firma los kubelet con su propia CA), genera los Secret con valores al azar y usa una capa de
kustomize temporal que fija `TRUSTED_PROXIES`. No modifica el repositorio ni toca otros clústeres.

## Qué hay

```text
k8s/
  kustomization.yaml          todo el sistema: base + hpa   ->  kubectl apply -k k8s
  verificar.py                revisión estática de los manifiestos (la corre la CI)
  base/
    namespace.yaml            el espacio de nombres gestor-inventario
    configuracion.yaml        ConfigMap sin secretos: TRUSTED_PROXIES y SESSION_SECURE_COOKIE
    bases-de-datos/           7 StatefulSet + Service (3 MySQL y 4 PostgreSQL), 1 GiB cada una, una por servicio (RNF02)
    <servicio>/               Deployment + Service de cada uno de los 8 componentes, y la Job de migraciones de los que la necesitan
    ingress.yaml              el único acceso desde fuera: cliente web y API Gateway (RNF09)
    politicas-de-red.yaml     NetworkPolicy: todo cerrado salvo lo que la Tabla 2 de la Entrega 2 necesita
    secretos.example.yaml     PLANTILLA de los Secret (no está en el kustomization)
    sembrar-administrador.yaml  Job para crear al primer administrador (se aplica a mano, una vez)
  hpa/                        HorizontalPodAutoscaler del Gateway y de ms-inventario: de 1 a 4 copias al 70 % de procesador (RNF05)
```

## Cómo se despliega

1. **Imágenes.** Construya las ocho y súbalas a un registro al que el clúster tenga acceso:

   ```bash
   docker build -t REGISTRO/api-gateway api-gateway           # y lo mismo con services/ms-* y web-client
   ```

   Los manifiestos usan nombres sin registro (`api-gateway:latest`). Para cambiarlos sin tocar los Deployments, descomente la sección
   `images:` de `k8s/base/kustomization.yaml`.
2. **Secretos.** No se versionan. Cree cada uno con valores reales (la plantilla `base/secretos.example.yaml` lista todos y trae el
   comando que genera cada valor):

   ```bash
   kubectl apply -f k8s/base/namespace.yaml
   NS=gestor-inventario
   for bd in api-gateway:gateway ms-catalogo:catalogo ms-proveedores:proveedores ms-inventario:inventario ms-compras:compras ms-notificaciones:notificaciones ms-reportes:reportes; do
     servicio=${bd%%:*}; corto=${bd##*:}
     kubectl -n $NS create secret generic db-$servicio --from-literal=nombre=${corto}_db --from-literal=usuario=$corto --from-literal=clave="$(openssl rand -base64 24)"
   done
   kubectl -n $NS create secret generic api-gateway-app --from-literal=APP_KEY="base64:$(openssl rand -base64 32)" --from-literal=JWT_SECRET="$(openssl rand -base64 48)"
   for s in ms-catalogo ms-proveedores web-client; do
     kubectl -n $NS create secret generic $s-app --from-literal=APP_KEY="base64:$(openssl rand -base64 32)"
   done
   ```

   `ms-notificaciones-smtp` es opcional (sin él, las alertas solo se ven en la interfaz).
3. **Configuración.** En `base/configuracion.yaml`: `TRUSTED_PROXIES` (la IP o el CIDR de los pods que ponen `X-Forwarded-For`: el
   controlador de Ingress y el cliente web) y `SESSION_SECURE_COOKIE` (`"true"` con HTTPS). En `base/ingress.yaml`: los dos dominios.
4. **Aplicar y esperar las migraciones.**

   ```bash
   kubectl apply -k k8s
   for j in api-gateway ms-catalogo ms-proveedores ms-inventario ms-reportes; do kubectl -n gestor-inventario wait --for=condition=complete job/$j-migrar --timeout=300s; done
   ```

5. **Primer administrador** (una sola vez; cree antes el Secret `api-gateway-admin` con `ADMIN_EMAIL` y `ADMIN_PASSWORD`):

   ```bash
   kubectl -n gestor-inventario apply -f k8s/base/sembrar-administrador.yaml
   kubectl -n gestor-inventario wait --for=condition=complete job/api-gateway-sembrar --timeout=300s
   kubectl -n gestor-inventario delete job/api-gateway-sembrar secret/api-gateway-admin
   ```

## Decisiones que conviene conocer

- **El controlador de Ingress.** Los manifiestos usan `ingressClassName: nginx`. El proyecto `ingress-nginx` fue **archivado en marzo de 2026**
  y ya no recibe correcciones: sirve para la entrega y las pruebas, pero para producción conviene migrar a otro controlador compatible con
  la API de Ingress (o a Gateway API).
- **RNF09, solo el Gateway y el cliente web salen del clúster.** El Ingress solo los enruta a ellos y todos los demás Service son
  `ClusterIP`. Como los microservicios confían en las cabeceras `X-User-*` y no tienen autenticación propia, lo que hace cierto el
  RNF09 son las **NetworkPolicy**: todo entrante queda denegado y solo se abre lo que llama la Tabla 2. Requieren un complemento de red que las
  haga cumplir (Calico, Cilium...); sin él se aceptan pero no se aplican. El de kind (kindnet) sí las aplica y se comprobó: un Pod sin
  permiso no llega a ningún servicio ni base, el Gateway llega a `ms-inventario` pero no a su base, y `ms-inventario` sí llega a la suya.
- **RNF05, escalado.** Solo el Gateway y `ms-inventario` tienen HPA (1 a 4 copias, 70 % de procesador). Necesita `metrics-server` y que cada
  Deployment declare `resources.requests.cpu`, lo que ya hacen. `ms-compras` y `ms-notificaciones` quedan en **una copia**: aplican sus
  migraciones al arrancar y `ms-notificaciones` programa su revisión diaria dentro del proceso (con dos copias correría dos veces).
- **Esperar a la base.** Los Pods de migración y los de `ms-compras` y `ms-notificaciones` (que migran al arrancar) llevan un contenedor
  de inicio que espera a su base. Corre con un UID numérico: con `runAsNonRoot`, busybox (que es root por defecto) sería rechazado.
- **Migraciones fuera del arranque.** Los demás servicios migran con una Job por despliegue, no al arrancar: con varias copias
  arrancando a la vez correrían a la vez. Los Deployments no esperan a las Job: hasta que terminen, el servicio responde pero sus rutas
  con base de datos fallan.
- **Imágenes con `USER` por nombre.** `ms-compras` (`USER node`) y `ms-notificaciones` (`USER notificaciones`) declaran el usuario por
  nombre, y con `runAsNonRoot` Kubernetes lo rechaza. Sus Deployments fijan un UID (`1000` y `10001`); lo ideal es corregirlo en sus
  Dockerfiles con un `USER` numérico, como ya hacen los demás.
- **Sesión del cliente web.** Va cifrada en una cookie: cualquier copia atiende a cualquier usuario, pero todas deben llevar la misma
  `APP_KEY` (el Secret `web-client-app`). No hay base de datos.
- **Almacenamiento.** Cada base usa un volumen de 1 GiB con la clase de almacenamiento por defecto del clúster; ajústelo para producción.

## Revisión estática

```bash
kubectl kustomize k8s | python3 k8s/verificar.py      # requiere PyYAML
```

Comprueba, entre otras cosas, que cada Service apunte a un pod que existe y al puerto que expone su imagen, que cada Secret y ConfigMap
referenciado exista, que cada contenedor declare recursos y sondas, que el Ingress solo publique el Gateway y el cliente web y que los HPA
sean de 1 a 4 copias al 70 %.
