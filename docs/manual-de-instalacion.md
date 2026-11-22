# Manual de instalación

Sistema de Gestión de Inventarios basado en microservicios — Distribuidora El Montañero S.A.S.

Este manual explica cómo instalar y poner en marcha el sistema completo de dos formas:

- **[A. Docker Compose](#a-instalación-con-docker-compose)**: en un solo equipo, para desarrollo, pruebas y demostraciones. Es la forma
  recomendada para empezar.
- **[B. Kubernetes](#b-instalación-con-kubernetes)**: el despliegue orquestado (RNF04), primero en un clúster local de prueba (kind) y
  luego en un clúster propio.

Los pasos de la parte A se comprobaron ejecutándolos sobre una copia limpia del repositorio (Linux, Docker 29.8 y Docker Compose v5.6):
el sistema arrancó con sus 15 contenedores sanos, el primer administrador entró, cambió su contraseña y las consultas por el API Gateway
respondieron. La parte B la probó el equipo en un clúster kind con `k8s/probar-en-kind.sh`.

---

## Qué se instala

| Componente | Tecnología | Base de datos | Acceso |
|---|---|---|---|
| Cliente web | Laravel (Blade + Bootstrap) | — | **Publicado**: es la interfaz de los usuarios |
| API Gateway | Laravel | MySQL | **Publicado**: única entrada a los microservicios (`/api/...`) y documentación en `/docs` |
| ms-catalogo, ms-proveedores | Laravel | MySQL | Solo dentro de la red del sistema |
| ms-inventario, ms-compras | Express (Node.js) | PostgreSQL | Dentro de la red (en Compose también publicados solo en `127.0.0.1`, para depurarlos) |
| ms-notificaciones | Flask | PostgreSQL | Dentro de la red (en Compose también publicado solo en `127.0.0.1`, para depurarlo) |
| ms-reportes | Flask | PostgreSQL | Solo dentro de la red del sistema |

Cada microservicio tiene su propia base de datos (RNF02) y aplica sus migraciones antes de arrancar. Los usuarios entran por el cliente
web, y el cliente web y cualquier otro cliente hablan solo con el API Gateway (RNF09).

---

## A. Instalación con Docker Compose

### A.1 Requisitos

| Requisito | Detalle |
|---|---|
| Sistema operativo | Linux, macOS o Windows con WSL 2 |
| Docker y Docker Compose | Docker Engine o Docker Desktop con **Compose v2 o superior** (`docker compose version`; se probó con Docker 29.8 y Compose v5.6) |
| Memoria | **8 GB de RAM** recomendados: el sistema en reposo usa unos 2 GB repartidos en 15 contenedores, y más bajo carga |
| Disco | Unos **6 GB libres** para las imágenes (hasta 800 MB cada una) y los volúmenes de las bases de datos |
| Herramientas | `git` y `openssl` (para generar los secretos). Para las pruebas de funcionamiento, además, `python3` y `curl` |
| Puertos libres en `127.0.0.1` | Cliente web **8080**, API Gateway **8000**; bases de datos 3307, 3308, 3309, 5433, 5434, 5435 y 5436; y 3001, 3002 y 5001 (ms-inventario, ms-compras y ms-notificaciones). Todos se pueden cambiar en el `.env` |

Nada queda expuesto fuera del equipo: todos los puertos se publican solo en `127.0.0.1`.

### A.2 Obtener el código

```bash
git clone https://github.com/Mat-FM/Sistemas_Gestor_Inventario.git
cd Sistemas_Gestor_Inventario
git checkout main          # versión estable (develop tiene lo último integrado)
```

### A.3 Configurar el archivo `.env`

Toda la configuración va en variables de entorno (RNF14), en un archivo `.env` en la raíz del repositorio. **Ese archivo no se sube al
repositorio**: tiene contraseñas y secretos.

```bash
cp .env.example .env
```

Abra `.env` y complete lo siguiente.

**1. Contraseñas de las bases de datos.** Cambie cada `*_DB_PASSWORD=change_me` por una contraseña propia.

**2. Secretos de las aplicaciones (obligatorios).** Vienen vacíos y el sistema no arranca sin ellos. Se generan una sola vez:

| Variable | Para qué | Cómo se genera |
|---|---|---|
| `JWT_SECRET` | Firma de los tokens de sesión del Gateway (al menos 32 caracteres) | `openssl rand -base64 48` |
| `GATEWAY_APP_KEY`, `CATALOGO_APP_KEY`, `PROVEEDORES_APP_KEY`, `WEB_APP_KEY` | Clave de cada aplicación Laravel | `echo "base64:$(openssl rand -base64 32)"` (una distinta para cada una) |

Para generarlos todos de una vez (Linux o WSL; en macOS use `sed -i ''` en lugar de `sed -i`):

```bash
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env
for v in GATEWAY_APP_KEY CATALOGO_APP_KEY PROVEEDORES_APP_KEY WEB_APP_KEY; do
  sed -i "s|^$v=.*|$v=base64:$(openssl rand -base64 32)|" .env
done
```

**3. Primer administrador (obligatorio).** Sin él nadie podría entrar, porque solo un administrador crea usuarios:

```text
ADMIN_EMAIL=admin@su-empresa.com
ADMIN_PASSWORD=Temporal2026
```

La contraseña es **temporal**: debe tener al menos 8 caracteres, con al menos una letra y un número, y el administrador la cambia en su
primer ingreso.

**4. Opcional:**

- **Puertos**: si alguno de los de A.1 ya está ocupado en su equipo, cámbielo (por ejemplo `WEB_PORT=8081`).
- **Correo de las alertas** (`ms-notificaciones`): `NOTIFICACIONES_SMTP_HOST`, `NOTIFICACIONES_SMTP_PORT`, `NOTIFICACIONES_SMTP_USER`,
  `NOTIFICACIONES_SMTP_PASSWORD` y `NOTIFICACIONES_MAIL_FROM`. Sin ellos, las alertas solo se ven en la interfaz.
- **Límite de peticiones del Gateway** (RNF19: 100 por minuto por usuario y 10 inicios de sesión por minuto por IP):
  `GATEWAY_RATE_LIMIT_PER_MINUTE` y `GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE`. Solo se suben para las pruebas de rendimiento.

### A.4 Levantar el sistema

```bash
docker compose up -d --build
```

La **primera vez tarda varios minutos**: descarga las imágenes base y construye las ocho imágenes del sistema. Las siguientes veces
reutiliza lo construido y arranca en menos de un minuto.

Al arrancar, en este orden:

1. Las siete bases de datos se inician y esperan a estar listas.
2. Cada servicio que lo necesita aplica sus migraciones en un contenedor propio (`*-migraciones`), que termina al acabar.
3. El contenedor de migraciones del Gateway crea los cuatro roles (ADMINISTRADOR, OPERADOR_BODEGA, VENDEDOR y CONTADOR) y el primer
   administrador con `ADMIN_EMAIL` y `ADMIN_PASSWORD`.
4. Arrancan los microservicios, el Gateway y el cliente web.

### A.5 Verificar que quedó arriba

```bash
docker compose ps
```

Deben aparecer **15 contenedores** `running` y `healthy`: 7 bases de datos, 6 microservicios, el Gateway y el cliente web. Los cinco
contenedores de migraciones no aparecen en esa lista porque ya terminaron; para verlos:

```bash
docker compose ps -a | grep migraciones      # deben estar Exited (0)
```

Y en el navegador o con `curl`:

| Dirección | Debe responder |
|---|---|
| http://127.0.0.1:8080 | La pantalla de inicio de sesión del cliente web |
| http://127.0.0.1:8000/health | `200`: el Gateway y su base funcionan |
| http://127.0.0.1:8000/docs | La documentación de la API (Swagger UI) |

### A.6 Primer ingreso

1. Abra el **cliente web** en http://127.0.0.1:8080.
2. Inicie sesión con `ADMIN_EMAIL` y `ADMIN_PASSWORD`.
3. El sistema le pide **cambiar la contraseña** antes de seguir (RF08): la nueva debe tener al menos 8 caracteres, con una letra y un
   número, y ser distinta de la temporal. Hasta cambiarla, cualquier otra operación responde «Debe cambiar su contraseña antes de
   continuar».
4. Después entra al inicio del administrador.

Con la API, sin el cliente web:

```bash
# Iniciar sesión: devuelve un token
curl -s -X POST http://127.0.0.1:8000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"correo":"admin@su-empresa.com","contrasena":"Temporal2026"}'

# Cambiar la contraseña con ese token (responde 204)
curl -s -X PUT http://127.0.0.1:8000/api/auth/contrasena -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"contrasena_actual":"Temporal2026","contrasena_nueva":"<nueva contraseña>"}'
```

Después de cambiarla, vuelva a iniciar sesión con la contraseña nueva para obtener un token sin restricciones.

### A.7 Primeros pasos con el sistema vacío

El sistema arranca sin datos. Desde el cliente web, como administrador (menú «Más»), se recomienda este orden, porque cada paso usa lo
anterior:

1. **Bodegas** (por ejemplo, la principal y el punto de venta).
2. **Categorías** y subcategorías (dos niveles).
3. **Productos**, cada uno en una categoría. También se pueden cargar desde un archivo CSV o Excel en **Importación masiva**, que trae
   las plantillas.
4. **Proveedores** y los productos que suministra cada uno.
5. **Usuarios**, con su rol: administrador, operador de bodega (asignado a una bodega), vendedor o contador. Cada uno entra con la
   contraseña temporal que le asigne el administrador y la cambia en su primer ingreso.
6. **Stock inicial**: con **Importación masiva** (tipo STOCK_INICIAL) o registrando entradas de mercancía.
7. **Stock mínimo** por producto y **configuración de las alertas** (días de anticipación de vencimientos y hora de la revisión diaria).

### A.8 Detener, reiniciar, actualizar y borrar

| Acción | Comando | Datos |
|---|---|---|
| Detener (sin borrar nada) | `docker compose stop` | Se conservan |
| Volver a encender | `docker compose start` | Se conservan |
| Apagar y quitar los contenedores | `docker compose down` | **Se conservan** (quedan en los volúmenes) |
| Actualizar a una versión nueva | `git pull` y luego `docker compose up -d --build` | Se conservan; las migraciones nuevas se aplican solas |
| **Borrar todo, incluidos los datos** | `docker compose down -v` | **Se pierden** las siete bases de datos |

Para volver a instalar desde cero (por ejemplo, para sembrar otro administrador): `docker compose down -v` y luego `docker compose up -d
--build`.

### A.9 Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `Bind for 127.0.0.1:8000 failed: port is already allocated` | Otro programa usa ese puerto. Cámbielo en el `.env` (`GATEWAY_PORT`, `WEB_PORT`, los `*_DB_PORT`...) y repita `docker compose up -d` |
| `Falta ADMIN_EMAIL en .env (ver .env.example)` (o `JWT_SECRET`, alguna `APP_KEY`...) | Falta un valor obligatorio del paso A.3 |
| `api-gateway-migraciones` termina con error | Casi siempre, `ADMIN_PASSWORD` no cumple la regla (8 caracteres, una letra y un número). Corríjala y repita `docker compose up -d`. Para ver el motivo: `docker compose logs api-gateway-migraciones` |
| Un servicio queda `unhealthy` o se reinicia | Revise su registro: `docker compose logs <servicio>` (por ejemplo `docker compose logs ms-reportes`). Los registros son JSON, una línea por petición, con su `request_id` |
| La construcción se queda detenida (visto con Docker Desktop) | Construya las imágenes de una en una y después levante el sistema: `for s in api-gateway web-client ms-catalogo ms-proveedores ms-inventario ms-compras ms-notificaciones ms-reportes; do docker compose build $s; done` y luego `docker compose up -d` |
| El cliente web dice «Demasiadas peticiones» o la API responde 429 | Es el límite de peticiones del Gateway (RNF19). Espere el tiempo que indica (`Retry-After`) |
| Una pantalla dice que un servicio no está disponible (503) | Ese microservicio o su base no responde: `docker compose ps` y `docker compose logs <servicio>`. El resto del sistema sigue funcionando (RNF18) |

### A.10 Comprobar todo el sistema (opcional)

El repositorio trae **67 pruebas de funcionamiento** que levantan el sistema en un proyecto aparte (puertos 18100 en adelante, sin tocar
su instalación), lo recorren por el Gateway y el cliente web, apagan servicios para comprobar la resiliencia y lo borran al terminar:

```bash
./smoke-tests/ejecutar.sh          # unos 7 minutos; necesita Docker, Python 3 y curl
```

Debe terminar con `67 de 67 pruebas OK`. Detalles en [`smoke-tests/README.md`](../smoke-tests/README.md).

---

## B. Instalación con Kubernetes

Los manifiestos están en [`k8s/`](../k8s) y se aplican con **kustomize** (incluido en `kubectl`). Incluyen los 8 componentes y las 7
bases de datos, las migraciones como Jobs, un Ingress que publica solo el cliente web y el Gateway, NetworkPolicy que aíslan cada base
(RNF02, RNF09) y el autoescalado del Gateway y de ms-inventario de 1 a 4 copias (RNF05). Las decisiones de diseño están en
[`k8s/README.md`](../k8s/README.md).

### B.1 Probar en un clúster local (kind)

**Requisitos:** Docker, `kubectl`, `kind`, `curl`, `lsof` y Python 3, y los puertos 18180, 18143, 18200 y 18201 libres.

Instalar `kind`:

```bash
# Linux (x86-64)
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-amd64 && chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind
# macOS
brew install kind
# Windows: choco install kind   (o winget install Kubernetes.kind)
```

Luego, desde la raíz del repositorio:

```bash
./k8s/probar-en-kind.sh                          # construye, despliega, prueba y borra el clúster (unos 15 minutos)
./k8s/probar-en-kind.sh --conservar --sin-carga  # lo deja encendido y omite la prueba de autoescalado
```

El script crea un clúster propio (`gi-prueba`, contexto `kind-gi-prueba`), construye las ocho imágenes de una en una y las carga,
instala el controlador de Ingress y `metrics-server`, crea los Secret con valores al azar, aplica `k8s/`, espera las migraciones, siembra al
administrador y verifica el Ingress, las NetworkPolicy, las pruebas de funcionamiento y el autoescalado. No toca otros clústeres ni
contenedores.

**Entrar al sistema con `--conservar`.** El Ingress escucha en `127.0.0.1:18180` y distingue por dominio. Agregue en `/etc/hosts` (en
Windows, `C:\Windows\System32\drivers\etc\hosts`):

```text
127.0.0.1  inventario.ejemplo.com api.inventario.ejemplo.com
```

Y abra http://inventario.ejemplo.com:18180 (cliente web) o http://api.inventario.ejemplo.com:18180/docs (Gateway). El script siembra al
administrador `admin@prueba.test`, y sus pruebas de funcionamiento le cambian la contraseña a `ClaveNueva2026A`: entre con esos datos.
Son credenciales de prueba, conocidas por estar en el repositorio: no use este clúster con datos reales. Para borrarlo:
`kind delete cluster --name gi-prueba`.

### B.2 Desplegar en un clúster propio

**Requisitos del clúster:**

- `kubectl` con acceso al clúster.
- Un **controlador de Ingress** compatible con `ingressClassName: nginx`.
- **metrics-server**, que el autoescalado necesita.
- Un **complemento de red que aplique NetworkPolicy** (Calico, Cilium...): sin él, las políticas se aceptan pero no aíslan nada.
- Una **clase de almacenamiento** por defecto, para los volúmenes de 1 GiB de cada base.

**Pasos** (los comandos completos están en [`k8s/README.md`](../k8s/README.md#cómo-se-despliega)):

1. **Imágenes.** Construya las ocho (`api-gateway`, `web-client` y los seis `services/ms-*`) y súbalas a un registro al que el clúster
   tenga acceso. Para usar el nombre del registro sin tocar los Deployments, descomente la sección `images:` de
   `k8s/base/kustomization.yaml`.
2. **Secretos.** Cree el espacio de nombres (`kubectl apply -f k8s/base/namespace.yaml`) y los Secret: uno por base de datos, la
   `APP_KEY` y el `JWT_SECRET` del Gateway, y la `APP_KEY` de ms-catalogo, ms-proveedores y el cliente web. La plantilla
   `k8s/base/secretos.example.yaml` los lista con el comando que genera cada valor. El de correo (`ms-notificaciones-smtp`) es opcional.
3. **Configuración.** En `k8s/base/configuracion.yaml`: `TRUSTED_PROXIES` (la red de los pods que ponen `X-Forwarded-For`) y
   `SESSION_SECURE_COOKIE` (`"true"` con HTTPS). En `k8s/base/ingress.yaml`: sus dos dominios, en lugar de `inventario.ejemplo.com` y
   `api.inventario.ejemplo.com`.
4. **Aplicar** y esperar las migraciones:

   ```bash
   kubectl apply -k k8s
   for j in api-gateway ms-catalogo ms-proveedores ms-inventario ms-reportes; do
     kubectl -n gestor-inventario wait --for=condition=complete job/$j-migrar --timeout=300s
   done
   ```

5. **Primer administrador**, una sola vez: cree el Secret `api-gateway-admin` con `ADMIN_EMAIL` y `ADMIN_PASSWORD`, aplique
   `k8s/base/sembrar-administrador.yaml`, espere la Job y bórrela junto con el Secret (comandos en `k8s/README.md`).
6. **Verificar:**

   ```bash
   kubectl -n gestor-inventario get pods          # todos Running y READY; las Job de migración Completed
   kubectl -n gestor-inventario get ingress,hpa
   ```

   Luego entre por el dominio del cliente web y siga [A.6](#a6-primer-ingreso) y [A.7](#a7-primeros-pasos-con-el-sistema-vacío).

Para entrar sin dominio (por ejemplo, para probar), use un reenvío de puerto:

```bash
kubectl -n gestor-inventario port-forward svc/web-client 8080:8000      # cliente web en http://127.0.0.1:8080
```

---

## Documentación de la API

- **API Gateway**: `/docs` (por ejemplo http://127.0.0.1:8000/docs). Es la única API que usan el cliente web y cualquier cliente externo.
- **Cada microservicio** publica su especificación OpenAPI en su propio `/docs` (RNF08), que solo se alcanza desde la red interna del
  sistema. Los documentos están también en el repositorio: `services/<servicio>/openapi.yaml` y `api-gateway/openapi.yaml`.
- El README de cada componente (`api-gateway/`, `web-client/` y `services/ms-*/`) detalla sus rutas, variables y decisiones.
