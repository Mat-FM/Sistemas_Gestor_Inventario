# Imagen de ms-compras (RNF03). Se construye desde esta carpeta:
#   docker build -t ms-compras services/ms-compras
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Primero solo las dependencias, para que Docker reutilice esta capa si el código cambia.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY openapi.yaml ./

# La imagen oficial de Node trae el usuario sin privilegios "node".
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

# Al arrancar aplica las migraciones pendientes y luego abre el puerto.
CMD ["node", "src/server.js"]
