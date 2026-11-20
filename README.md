# Sistema de Gestión de Inventarios basado en Microservicios

Caso de estudio: **Distribuidora El Montañero S.A.S.** (Manizales).
Proyecto de aula de Ingeniería de Software II, Universidad Nacional de Colombia, Sede Manizales.

Integrantes: Luis Alejandro Saraza Marín, Brayan David Collazos Escobedo y Mateo Falla Muñoz.

## Arquitectura

Un API Gateway propio (único punto de entrada, gestiona usuarios y roles) y seis microservicios,
cada uno con su propia base de datos. Toda la comunicación es REST con JSON. El diseño completo
está en [`docs/entrega-2`](docs/entrega-2) y la justificación y los requerimientos en [`docs/entrega-1`](docs/entrega-1).

| Componente | Framework | Base de datos | Puerto (clúster) |
| --- | --- | --- | --- |
| `api-gateway` | Laravel | MySQL | 8000 |
| `services/ms-catalogo` | Laravel | MySQL | 8000 |
| `services/ms-proveedores` | Laravel | MySQL | 8000 |
| `services/ms-inventario` | Express | PostgreSQL | 3000 |
| `services/ms-compras` | Express | PostgreSQL | 3000 |
| `services/ms-notificaciones` | Flask | PostgreSQL | 5000 |
| `services/ms-reportes` | Flask | PostgreSQL | 5000 |
| `web-client` | Laravel (Blade + Bootstrap) | — | — |

## Estructura del repositorio (monorepo)

```text
api-gateway/          API Gateway (incluye usuarios y roles)
services/             Los seis microservicios
web-client/           Cliente web (solo se comunica con el Gateway)
k8s/                  Archivos de configuración de Kubernetes
performance-tests/    Pruebas de rendimiento (Locust), una carpeta por integrante
smoke-tests/          Pruebas de funcionamiento de todo el sistema en contenedores (53 pruebas)
docs/                 Documentos de cada entrega y contratos de API
bitacoras-ia/         Bitácoras de uso de IA de cada entrega
.github/workflows/    Integración continua
docker-compose.yml    Entorno local: las siete bases de datos, los siete servicios y el cliente web
```

## Entorno local

```bash
cp .env.example .env      # cambiar las contraseñas y completar los secretos (cada uno trae el comando que lo genera)
docker compose up -d --build
```

Levanta todo el sistema: cada servicio aplica sus migraciones en su propio contenedor antes de arrancar, y el del Gateway siembra al
primer administrador con `ADMIN_EMAIL` y `ADMIN_PASSWORD`. Quedan publicados, solo en `127.0.0.1`, el **cliente web**
(`WEB_PORT`, 8080 por defecto) y el **API Gateway** (`GATEWAY_PORT`, 8000; documentación en `/docs`); los microservicios se hablan
por la red de Compose. Si algún puerto ya lo usa otro proyecto de su equipo, cámbielo en el `.env`.

Puertos de las bases de datos en el equipo local: MySQL 3307 (gateway), 3308 (catálogo), 3309 (proveedores);
PostgreSQL 5433 (inventario), 5434 (compras), 5435 (notificaciones), 5436 (reportes).

Kubernetes (RNF04): los manifiestos están en [`k8s/`](k8s) con sus instrucciones; `k8s/probar-en-kind.sh` los despliega y prueba en un
clúster local.

Pruebas de funcionamiento: `./smoke-tests/ejecutar.sh` levanta todo con Docker Compose en un proyecto aparte, corre las 53 pruebas de
[`smoke-tests/`](smoke-tests) y lo borra.

## Convenciones

- Ramas: `main` (versión estable), `develop` (integración) y `feature/<servicio>-<descripción>`.
- Todo cambio entra por pull request hacia `develop`, revisado por otro integrante.
- Commits con Conventional Commits (`feat:`, `fix:`, `docs:`).
- Cada servicio publica su especificación OpenAPI en `/docs` y expone `/health`.
- La configuración que cambia según el entorno va en variables de entorno, nunca en el código.
- Cada integrante mantiene sus pruebas de rendimiento (Locust) en `performance-tests/<nombre>/`.
