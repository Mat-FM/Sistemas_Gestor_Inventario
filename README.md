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
performance-tests/    Pruebas de rendimiento k6, una carpeta por integrante
docs/                 Documentos de cada entrega y contratos de API
bitacoras-ia/         Bitácoras de uso de IA de cada entrega
.github/workflows/    Integración continua
docker-compose.yml    Entorno local (por ahora, solo las bases de datos)
```

## Entorno local

```bash
cp .env.example .env      # cambiar las contraseñas
docker compose up -d      # levanta las siete bases de datos
```

Puertos de las bases de datos en el equipo local: MySQL 3307 (gateway), 3308 (catálogo), 3309 (proveedores);
PostgreSQL 5433 (inventario), 5434 (compras), 5435 (notificaciones), 5436 (reportes).

## Convenciones

- Ramas: `main` (versión estable), `develop` (integración) y `feature/<servicio>-<descripción>`.
- Todo cambio entra por pull request hacia `develop`, revisado por otro integrante.
- Commits con Conventional Commits (`feat:`, `fix:`, `docs:`).
- Cada servicio publica su especificación OpenAPI en `/docs` y expone `/health`.
- La configuración que cambia según el entorno va en variables de entorno, nunca en el código.
- Cada integrante mantiene sus pruebas de rendimiento en `performance-tests/<nombre>/`.
