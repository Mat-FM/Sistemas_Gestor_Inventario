# Imagen de ms-reportes (RNF03): Flask servido con gunicorn.
#
# Construir (desde services/ms-reportes):  docker build -t ms-reportes .
# La configuración llega por variables de entorno (RNF14); la imagen no lleva ningún .env.

FROM python:3.14-slim

# Sin archivos .pyc y con la salida sin búfer, para que los registros JSON salgan de inmediato.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Primero solo las dependencias: si el código cambia pero requirements.txt no, Docker reutiliza esta capa.
COPY requirements.txt .
RUN pip install -r requirements.txt

# El código y lo que necesita en ejecución: las migraciones y los archivos de /docs.
COPY app ./app
COPY migrations ./migrations
COPY docs ./docs
COPY openapi.yaml .

# Se ejecuta con un usuario sin privilegios, no como root.
RUN useradd --create-home --uid 10001 servicio
USER servicio

# FLASK_APP permite ejecutar `flask db upgrade` dentro del contenedor.
ENV FLASK_APP=app \
    PORT=5000 \
    GUNICORN_WORKERS=2

EXPOSE 5000

# Docker marca el contenedor como no sano si /health no responde 200 (PostgreSQL caído).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health', timeout=4)"

# exec: gunicorn queda como el proceso principal y recibe la señal de parada de Docker para terminar ordenadamente.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT} --workers ${GUNICORN_WORKERS} 'app:create_app()'"]
