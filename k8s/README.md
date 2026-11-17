# Kubernetes (RNF04)

Manifiestos del sistema completo con **kustomize** (`kubectl kustomize` ya viene con `kubectl`; no hace falta instalar nada más).

> **Estado:** estos manifiestos se revisaron de forma **estática** (`kubectl kustomize` y `k8s/verificar.py`, que corre en la CI) y las
> imágenes se construyeron y probaron con Docker Compose, pero **no se desplegaron todavía en ningún clúster**: en el equipo de
> desarrollo no había uno. Las primeras pruebas reales (arranque, migraciones, Ingress, NetworkPolicy y HPA) están pendientes.

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

- **RNF09, solo el Gateway y el cliente web salen del clúster.** El Ingress solo los enruta a ellos y todos los demás Service son
  `ClusterIP`. Como los microservicios confían en las cabeceras `X-User-*` y no tienen autenticación propia, lo que hace cierto el
  RNF09 son las **NetworkPolicy**: todo entrante queda denegado y solo se abre lo que llama la Tabla 2. Requieren un complemento de red que las
  haga cumplir (Calico, Cilium...); sin él se aceptan pero no se aplican.
- **RNF05, escalado.** Solo el Gateway y `ms-inventario` tienen HPA (1 a 4 copias, 70 % de procesador). Necesita `metrics-server` y que cada
  Deployment declare `resources.requests.cpu`, lo que ya hacen. `ms-compras` y `ms-notificaciones` quedan en **una copia**: aplican sus
  migraciones al arrancar y `ms-notificaciones` programa su revisión diaria dentro del proceso (con dos copias correría dos veces).
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
