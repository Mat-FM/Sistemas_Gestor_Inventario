# Pruebas de rendimiento — Luis Saraza

15 pruebas con [Locust](https://locust.io) sobre los dos servicios a cargo de Luis: **ms-compras** (C01 a C09) y
**ms-notificaciones** (N01 a N06).

## Criterio (RNF06, Entrega 1)

> Las consultas responden en menos de 2 s en el 95 % de los casos (percentil 95) y con menos de 1 % de errores, con
> 50 usuarios simulados al mismo tiempo durante 5 minutos.

Las pruebas de **carga** verifican RNF06 con exactamente esa carga. Las demás (escritura, integración, contención,
estrés y pico) se comparan con el mismo umbral, pero son **de referencia**: buscan dónde se degrada el servicio.
Cada usuario simulado espera entre 1 y 2 s entre operaciones, como una persona usando la interfaz.

## Las 15 pruebas

| ID | Tipo | Usuarios | Duración | Qué mide |
|---|---|---|---|---|
| C01 | carga | 50 | 5 min | Listado paginado de órdenes de compra |
| C02 | carga | 50 | 5 min | Listado de órdenes con filtros (estado, bodega y proveedor, rango de fechas) |
| C03 | carga | 50 | 5 min | Detalle de una orden con sus líneas y recepciones |
| C04 | carga | 50 | 5 min | Recepciones de una orden |
| C05 | carga | 50 | 5 min | Listado de devoluciones a proveedor |
| C06 | escritura | 50 | 5 min | Creación de órdenes a la vez (número consecutivo sin repetir) |
| C07 | integración | 20 | 5 min | Crear → enviar → recibir con lote → consultar: compras → inventario → catálogo, y aviso a notificaciones |
| C08 | contención | 30 | 3 min | Recepciones simultáneas sobre la misma orden (candado por orden) |
| C09 | estrés | 0 → 200 | 5 min | Consultas de órdenes con un usuario más cada segundo, hasta 200 |
| N01 | carga | 50 | 5 min | Notificaciones del rol del usuario, primera y otras páginas |
| N02 | carga | 50 | 5 min | Notificaciones sin leer y por tipo, y marcar como leída |
| N03 | carga | 50 | 5 min | Preferencia de correo (ver y guardar) y configuración de alertas |
| N04 | escritura | 50 | 5 min | Avisos internos nuevos de inventario (STOCK_BAJO) y compras (ORDEN_RECIBIDA) |
| N05 | contención | 50 | 3 min | Avisos repetidos para 5 productos: el índice único no deja duplicar alertas sin leer |
| N06 | pico | 200 en 2 s | 2 min | Llegada brusca de usuarios con el uso típico de la campana de alertas |

La definición exacta (clase, usuarios, ritmo de llegada y duración) está en [escenarios.py](escenarios.py); el
código, en [compras.py](compras.py) y [notificaciones.py](notificaciones.py).

## Modos

| `PERF_MODO` | Cómo llega la petición | Para qué |
|---|---|---|
| `directo` (por defecto) | Al servicio, con las cabeceras `X-User-*` que pondría el Gateway | Medir el servicio aislado; sirve mientras el Gateway no esté en docker compose |
| `gateway` | `POST /api/auth/login` y luego `/api/<ruta>` con el token JWT | La medición que pide la Entrega 3: todo por el Gateway |

`POST /internas/notificaciones` (N04, N05 y parte de N06) va siempre directo: el Gateway no publica las rutas internas,
las llaman ms-inventario y ms-compras dentro de la red.

**Límites del Gateway (RNF19).** El Gateway acepta 100 peticiones por minuto **por usuario** y 10 inicios de sesión
por minuto por IP. Con un usuario simulado haciendo una petición cada 1,5 s (unas 40 por minuto), una cuenta alcanza
para 2 usuarios simulados: 50 usuarios simulados necesitan **al menos 25 cuentas**, y se inician sesión de a una
por cuenta (25 inicios ≈ 2,5 min con el límite de 10 por minuto). Hay dos salidas:

1. Crear 25 o más cuentas de prueba (un seeder en el Gateway) y pasarlas en `PERF_USUARIOS`.
2. Correr el Gateway del entorno de pruebas con `RATE_LIMIT_PER_MINUTE` y `LOGIN_RATE_LIMIT_PER_MINUTE` altos, y
   decirlo en el informe: entonces se mide el rendimiento, no el límite.

Si no, los 429 cuentan como errores y la prueba no cumple por el limitador, no por el servicio.

## Requisitos de datos

- **C07 y C08** reciben mercancía: ms-inventario debe tener la bodega `PERF_ID_BODEGA` (1) y ms-catalogo el producto
  activo `PERF_ID_PRODUCTO` (1). Sin ms-catalogo, inventario responde 503 y esas pruebas fallan.
- Las demás preparan sus datos al empezar (40 órdenes en varios estados, recepciones, una devolución y 300
  alertas). La preparación no cuenta en las mediciones.
- **Las pruebas escriben en las bases de datos** (órdenes, movimientos, alertas). Córralas en un entorno de pruebas,
  no sobre los datos de la demo.

## Ejecutar

No hace falta instalar nada: se usa la imagen oficial de Locust en la red de docker compose. Con los servicios arriba
(`docker compose up -d ms-inventario ms-compras ms-notificaciones` y ms-catalogo), desde esta carpeta:

```bash
docker run --rm --network gestor-inventario_default -v "$PWD":/mnt/locust -w /mnt/locust \
  --entrypoint python locustio/locust:2.31.8 ejecutar.py
```

- Solo algunas: `... ejecutar.py C01 N03`.
- Comprobación rápida (10 usuarios, 30 s por prueba; no vale como resultado): `... ejecutar.py --rapido`.
- Por el Gateway: agregar `-e PERF_MODO=gateway -e PERF_GATEWAY_URL=http://api-gateway:8000 -e PERF_USUARIOS="correo1:clave1,correo2:clave2,..."`.
- Otras direcciones: `PERF_COMPRAS_URL`, `PERF_NOTIFICACIONES_URL`; otros datos: `PERF_ID_PRODUCTO`, `PERF_ID_BODEGA`,
  `PERF_ID_PROVEEDOR`.
- Una prueba con la interfaz web de Locust (gráficas en vivo): `docker run --rm -p 8089:8089 --network gestor-inventario_default
  -v "$PWD":/mnt/locust -w /mnt/locust locustio/locust:2.31.8 -f compras.py ListadoOrdenes` y abrir http://localhost:8089.

Las 15 con su duración completa tardan unos 70 minutos. Cada una deja en `results/` (no se versiona) sus CSV y un
informe HTML de Locust, y al final `resumen.py` escribe [RESULTADOS.md](RESULTADOS.md) con la tabla de resultados y el
veredicto frente a RNF06.
