# Imagen de ms-inventario (RNF03): Express sobre Node 22.
#
# Construir (desde services/ms-inventario):  docker build -t ms-inventario .
# La configuración llega por variables de entorno (RNF14); la imagen no lleva ningún .env.

FROM node:22-slim

# production: Express deja de ser verboso y `npm ci` omite las dependencias de desarrollo. PORT es el puerto por defecto del
# servicio (src/config/env.js); lo demás (DB_*, MS_*_URL, CALL_TIMEOUT_MS) lo pone quien ejecute el contenedor.
ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Primero solo las dependencias de producción: si el código cambia pero package-lock.json no, Docker reutiliza esta capa.
# knex y pg son dependencias de producción: `node_modules/.bin/knex migrate:latest` funciona dentro de la imagen.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# El código y lo que lee en ejecución: las migraciones, knexfile.js (lo usa la CLI de Knex) y openapi.yaml, que con
# src/docs/swagger-ui.html sirve /docs. Si falta cualquiera de los dos archivos de /docs, el servicio no arranca (createApp
# los lee al construirse) y el contenedor se reiniciaría sin parar: por eso cada COPY nombra su origen y no se copia todo con
# `COPY . .`, que además metería el .env del equipo.
COPY src ./src
COPY migrations ./migrations
COPY knexfile.js openapi.yaml ./

# Se ejecuta con un usuario sin privilegios, no como root. La imagen ya trae el usuario `node` (UID 1000); aquí se crea uno
# propio con un UID alto y fijo, y USER lo nombra por su número: con `runAsNonRoot: true` en el securityContext de Kubernetes,
# el kubelet rechaza una imagen cuyo USER es un nombre, porque no puede comprobar que no sea root.
RUN useradd --create-home --uid 10001 servicio
USER 10001

EXPOSE 3000

# Docker marca el contenedor como no sano si /health no responde 200. /health es una sonda de VIDA: no consulta la base de
# datos (D17, RNF10), y responde 503 si falta una variable obligatoria o una URL no es válida. La imagen slim no trae curl, así
# que la sonda es el propio Node. fetch NO lanza con un 503: se mira r.ok para que ese caso salga con código 1, y el plazo
# propio de 4 s deja que la sonda termine antes que el --timeout.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Forma exec: el proceso Node es el principal (PID 1) y recibe SIGTERM de `docker stop` o de Kubernetes. src/server.js lo
# atiende: termina las peticiones en curso, cierra el pool de la base y sale con 0.
CMD ["node", "src/server.js"]
