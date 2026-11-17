# Imagen de ms-notificaciones (RNF03). Se construye desde esta carpeta:
#   docker build -t ms-notificaciones services/ms-notificaciones
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # La hora de la revisión diaria se interpreta en la hora de Colombia.
    TZ=America/Bogota

# tzdata trae las zonas horarias; la imagen slim no las incluye.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

# Primero solo las dependencias, para que Docker reutilice esta capa si el código cambia.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY migrations ./migrations
COPY openapi.json wsgi.py ./

# Usuario sin privilegios.
RUN useradd --system --no-create-home notificaciones
USER notificaciones
EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=2)" || exit 1

# Un solo proceso con varios hilos: la revisión diaria corre una sola vez por contenedor.
# Al arrancar aplica las migraciones pendientes (wsgi.py) y luego abre el puerto.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "8", "wsgi:app"]
