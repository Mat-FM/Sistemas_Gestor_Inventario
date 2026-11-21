# web-client

Interfaz web del sistema para el personal de la distribuidora. Solo se comunica con el API Gateway (RNF21).

- **Framework:** Laravel 13 (PHP 8.4) con plantillas Blade y Bootstrap 5 · **Base de datos:** ninguna
- **Requerimientos que toca:** RF01 a RF10, RF12, RF13, RF14 y RF17 (lo que ya está integrado en el Gateway; ver «Qué incluye»)
- Se usa desde pantallas de 360 px de ancho (celular o tableta en la bodega) hasta computador: menú inferior en celular y barra lateral desde 768 px; los controles táctiles miden al menos 44 px.

## Qué incluye

| Pantalla | Quién | Qué hace |
| --- | --- | --- |
| Inicio de sesión y cambio de contraseña | Todos | Entra por el Gateway. Una contraseña temporal obliga a cambiarla antes de seguir (RF08) |
| Inicio | Todos, distinto por rol | **Administrador:** productos con poco stock, indicadores (valor del inventario, agotados, lotes por vencer y órdenes por recibir), acciones rápidas, traslados en camino y últimos movimientos. **Operador:** traslados y órdenes de compra por recibir en su bodega (con botón «Recibir»), acciones rápidas y movimientos de su bodega. **Vendedor:** buscador de productos. **Contador:** valor del inventario, indicadores, lo que más sale y accesos de lectura |
| Stock | Todos | Existencias por producto y bodega, con búsqueda por nombre o código (RF05, RF12). Un operador ve solo su bodega |
| Movimientos | Administrador, operador (registrar y ver), contador (ver) | Registra **entradas, salidas, devoluciones de cliente y ajustes** (el ajuste exige sentido y motivo; el lote y su vencimiento son opcionales en las entradas) y muestra el historial con nombres y saldo (RF04, RF10, RF13). Una salida avisa de los lotes que ya vencieron |
| Traslados | Administrador y operador | Envía y recibe mercancía entre bodegas en dos pasos (RF04) |
| Lotes por vencer | Administrador y operador | Los lotes con existencia que vencen en los próximos 7 a 365 días, del que vence primero al último, con los días que faltan y los ya vencidos marcados (RF17). El operador ve solo su bodega |
| Conteos físicos | Administrador y operador | El administrador **programa** un conteo de una bodega (todos los productos con existencia, hasta 1.000); el operador de esa bodega **registra lo contado** (puede guardar por partes y repetirlo) y el administrador lo **aprueba**: el inventario se ajusta a lo contado con un movimiento por cada diferencia (RF18). Las líneas sin contar no se tocan. Aprobar lleva clave de idempotencia |
| Reportes y auditoría | Administrador y contador | **Existencias, valorización, rotación y kardex** en pantalla y para descargar en **CSV y PDF**, tal como los genera `ms-reportes` (RF11, RF15). El kardex filtra por producto, bodega, tipo, fechas y (el administrador) usuario y dibuja los 100 movimientos más recientes; el archivo trae todos |
| Compras | Administrador y operador | **Órdenes de compra:** crear (administrador), enviar, anular y **recibir la mercancía total o parcialmente**, con lote y vencimiento (RF06). **Devoluciones a proveedor:** salen del inventario de la bodega (RF13). El operador abre por defecto las órdenes de SU bodega y recibe solo en ella |
| Alertas | Todos | La campana del menú cuenta las alertas sin leer de tu rol; la pantalla las lista con nombres, permite marcarlas como leídas y cada usuario decide si las recibe por correo (RF09, RF17) |
| Administrar (menú «Más») | Solo el administrador | **Productos** (crear, editar, dar de baja y buscar; RF01, RF12), **categorías** de dos niveles (RF02), **proveedores** y los productos que suministran (RF03), **bodegas** (RF05), **stock mínimo** por producto, **usuarios** con su rol y bodega, contraseña temporal y baja (RF07) y la **configuración de las alertas** (días de anticipación y hora de la revisión diaria) y la **importación masiva** de productos, proveedores y stock inicial desde CSV o Excel, con plantillas y los errores fila por fila (RF16) |


## Diseño

La identidad es **la cordillera y el café** (Manizales): verde selva y madera sobre papel crema, con el ámbar de la cosecha como acento. No es una plantilla de Bootstrap con otro color: todo lo visual sale de las variables de `public/css/app.css` (paleta, radios, sombras) y Bootstrap queda debajo solo para la rejilla, los formularios y los menús.

- **Marca:** un signo propio (montañas y sol sobre verde, `public/img/marca.svg`, que también es el favicon) con el nombre en serif.
- **Tipografía:** *Fraunces* (títulos y cifras) y *Hanken Grotesk* (texto), ambas con licencia OFL y alojadas en `public/vendor/fuentes/` (con sus licencias): no se pide nada a internet.
- **Estructura:** en celular, barra superior oscura con una línea ámbar y menú inferior flotante con el elemento activo resaltado; desde `md`, barra lateral verde oscuro con curvas de nivel de fondo, indicador ámbar del elemento activo y la cuenta (avatar con iniciales) al pie.
- **Acceso:** dos paneles (la marca con su lema y el formulario); en celular el panel pasa arriba.
- **Inicio:** saludo según la hora de la distribuidora, con la fecha y lo que cada rol viene a hacer; indicadores con un riel de color por tipo, acciones grandes con su ícono de color y estados vacíos con ilustración.
- **Computador:** desde 1200 px el contenido gana ancho (hasta 88 rem en pantallas grandes) y el inicio se reparte en dos columnas (indicadores arriba; lo urgente y los accesos debajo); la lista de stock pasa a rejilla de tarjetas y los formularios no se estiran. Una barra superior trae la búsqueda de producto (la tecla `/` la enfoca desde cualquier pantalla, salvo en Stock, que ya tiene la suya) y la campana de alertas. Se revisó a 1024, 1366 y 1920 px.
- **Movimiento:** los bloques entran con una animación suave que se desactiva con «reducir movimiento» del sistema.
- **Accesibilidad:** objetivos táctiles de al menos 44 px, foco visible en ámbar, contraste de texto sobre fondo claro y oscuro, y todo se verificó en pantallas desde 360 px hasta 1920 px.
- **Indicadores que no se pueden calcular:** si un servicio no responde, el panel muestra «—» (no un 0) y avisa que faltan datos; el resto sigue al día.

## Cómo funciona

- **Sesión:** el token del Gateway va en la sesión de Laravel, guardada en una cookie cifrada y `HttpOnly` (así no hace falta base de datos ni sesión compartida entre copias); nunca llega al HTML ni a JavaScript. La sesión dura lo mismo que el token (60 minutos). Si el Gateway responde 401, se cierra y se vuelve al inicio de sesión. Por eso **todas las copias deben llevar la misma `APP_KEY`** (con otra no pueden leer la cookie de la otra) y, bajo HTTPS, hay que poner `SESSION_SECURE_COOKIE=true`.
- **Un solo cliente HTTP:** `app/Gateway/GatewayClient.php` es el único código que conoce direcciones, cabeceras y plazos (5 s: más que los 3 s del Gateway a cada servicio, para ver su 503 en vez de cortar antes). Convierte cada error en una `GatewayException` y `bootstrap/app.php` decide qué se le dice al usuario: sesión vencida, cambio de contraseña pendiente, sin permiso (403), no existe (404), límite de peticiones (429, con `Retry-After`) y servicio no disponible (503).
- **Idempotencia (RNF17):** cada formulario de movimiento o traslado genera una `Idempotency-Key` al mostrarse. Tras un fallo que no se sabe si llegó a ejecutarse (el Gateway no responde, 5xx) la clave se conserva y repetir no duplica; tras un rechazo definitivo (4xx) se descarta y el formulario genera otra. Además, un formulario que modifica datos se envía una sola vez: el botón se deshabilita al primer toque (`public/js/app.js`).
- **Nombres en vez de ids:** los listados de inventario solo traen `id_producto` e `id_bodega`; `app/Services/Nombres.php` los convierte con un caché corto (300 s, de archivos) para cuidar el límite de 100 peticiones por minuto por usuario.
- **Cada bloque falla por su lado:** si un servicio no responde, el inicio se muestra igual y ese bloque dice «no disponible».
- **Formularios de administración:** validan en español antes de llamar al servicio (los de Laravel responden algunos mensajes en inglés) y, si el servicio rechaza algo, el mensaje sale junto al campo (código o NIT repetido, correo repetido...) con lo escrito conservado, salvo las contraseñas. Los precios se escriben a la colombiana (`18.500` o `18.500,50`).
- **Roles:** `ExigeRol` evita pantallas que el rol no puede usar y el menú solo muestra lo permitido, pero la autoridad es el Gateway, que vuelve a comprobar el rol en cada petición. El operador siempre opera sobre su bodega (la que dice el Gateway), aunque el formulario traiga otra.
- **Capas (RNF13):** rutas (`routes/web.php`) → controladores (`app/Http/Controllers`) → servicios (`app/Services`: `Catalogo`, `Inventario`, `Reportes`, `Nombres`) → cliente del Gateway.
- **Fechas y números:** los instantes llegan en UTC y se muestran en hora de Bogotá (`config/interfaz.php`); los números, en formato colombiano. Las cantidades son enteros (el servicio no admite decimales).
- **Sin npm ni compilación:** Bootstrap 5.3.8 e iconos 1.13.1 están copiados en `public/vendor/` (con sus licencias), así que la interfaz funciona sin internet y sin `node`.

## Requisitos del Gateway y del despliegue

- **`TRUSTED_PROXIES` del Gateway:** el Gateway limita los inicios de sesión por IP (10 por minuto). Este cliente envía `X-Forwarded-For` con la IP real de cada usuario; si el Gateway no confía en este servidor, verá siempre la misma IP y todos los usuarios compartirían un solo límite. Hay que poner la IP o el CIDR de este servicio en `TRUSTED_PROXIES` del Gateway.
- **Proxies de confianza de este cliente:** detrás de un Ingress, `request()->ip()` es la IP del Ingress salvo que este servicio también confíe en él (`trustProxies` en `bootstrap/app.php`, solo con IP o CIDR concretos, nunca `*`). Sin eso, el `X-Forwarded-For` que envía al Gateway no sirve para lo que fue pensado. Está pendiente de configurar con el despliegue en `k8s/`.
- Las alertas son **por rol**: hoy todos los avisos de los servicios (stock bajo, vencimientos, órdenes recibidas) van al rol ADMINISTRADOR, así que la campana de los demás roles siempre está vacía. Es del diseño de `ms-notificaciones`, no de la interfaz.
- `GET /indicadores` falla entero (503) si `ms-compras` o `ms-inventario` no responden: por eso el inicio lo trata como un bloque aparte.

## Instalación y ejecución

```bash
cd web-client
composer install
cp .env.example .env
php artisan key:generate
# en .env: API_GATEWAY_URL con la dirección del Gateway
php artisan serve --host=127.0.0.1 --port=<puerto libre>
```

Variables (`.env.example`): `API_GATEWAY_URL` (único servicio que conoce, RNF14), `API_GATEWAY_TIMEOUT` (segundos), `APP_TIMEZONE`, y la sesión en cookie, el caché en archivos y `DB_CONNECTION=null` (no hay base de datos).

## Docker (RNF03)

La imagen parte de `php:8.4-apache` y sirve `public/` con Apache como `www-data` (UID 33, numérico para que Kubernetes lo acepte con
`runAsNonRoot`) en el puerto 8000. Instala solo las dependencias de producción y **no lleva el `.env`**, las pruebas ni los registros
del equipo (`.dockerignore`). Trae fijos los valores que no son secretos en su versión de producción (`APP_ENV=production`,
`APP_DEBUG=false`, registro en JSON por la salida de errores, sesión en cookie, caché en archivos, sin base de datos); el resto llega
por variables de entorno.

```bash
docker build -t web-client web-client      # desde la raíz del repositorio
KEY=$(docker run --rm web-client php artisan key:generate --show)
docker run -d --name web-client -p 127.0.0.1:<puerto libre>:8000 -e APP_KEY="$KEY" -e API_GATEWAY_URL=http://<dirección del Gateway> web-client
```

| Variable | ¿Obligatoria? | Para qué |
| --- | --- | --- |
| `APP_KEY` | Sí | Cifra la cookie de sesión. **La misma en todas las copias**; sin ella toda petición responde 500 |
| `API_GATEWAY_URL` | Fuera del clúster | Por defecto `http://api-gateway:8000` (el Service del Gateway) |
| `TRUSTED_PROXIES` | Detrás de un Ingress | IP o CIDR del Ingress, separados por comas (nunca `*`) para que la IP real del usuario llegue al Gateway |
| `SESSION_SECURE_COOKIE` | Con HTTPS | `true` cuando el Ingress sirve HTTPS |
| `API_GATEWAY_TIMEOUT`, `LOG_LEVEL` | No | 5 segundos y `debug` por defecto |

La sonda de salud es `GET /up`: responde 200 cuando Laravel arranca y **no** consulta al Gateway (una caída del Gateway no debe reiniciar
este contenedor). Cada petición se registra en JSON con el nombre del servicio, un `request_id` propio (también en la cabecera
`X-Request-Id` de la respuesta), la ruta sin la cadena de consulta, el estado, el usuario y la duración (RNF10); un fallo del Gateway se
anota con el `X-Request-Id` que él devolvió, para seguir la petición. También está en el `docker-compose.yml` de la raíz y en
[`k8s/`](../k8s). `.github/workflows/ci-web-client.yml` corre las pruebas con cobertura mínima del 60 % (hoy 89 %), revisa el estilo
con Pint y construye la imagen.

## Pruebas

```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT vendor/bin/phpunit --colors=never
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT vendor/bin/pint --test
```

Las pruebas sustituyen al Gateway con `Http::fake()` (no necesitan la pila ni el `.env`): acceso y errores (401, 403, 429, 503, respuesta sin JSON), inicio por rol, búsqueda de stock, registro de movimientos (clave de idempotencia conservada o renovada, tipos permitidos, bodega del operador, lotes) y traslados. Comprueban además que el token no aparece en el HTML, que las contraseñas escritas no se guardan en la sesión y que no se toca ninguna base de datos.

## Pendiente

- Conteos: se cuenta siempre la bodega completa (hasta 1.000 productos con existencia); elegir solo algunos productos (`ids_producto`) todavía no tiene pantalla.
- Importaciones: el Gateway espera 3 s a `ms-reportes`; un archivo grande puede seguir procesándose cuando la pantalla ya recibió el 503, y entonces se manda al historial para revisarlo antes de volver a subirlo.
- Los reportes grandes pueden pasar de los 3 s que el Gateway espera a cada servicio y responder 503: la pantalla sugiere acotar el periodo o la bodega.
- Editar una orden de compra todavía en estado «Creada» (hoy se crea, se envía o se anula).
- Una salida con lote por elección del usuario (hoy sale primero el lote que vence antes, FEFO) y la devolución de un traslado atascado.
