# Imagen del api-gateway (RNF03): Laravel 13 servido con Apache y PHP 8.4.
#
# Construir (desde api-gateway):  docker build -t api-gateway .
# La configuración llega por variables de entorno (RNF14); la imagen no lleva ningún .env ni ningún secreto.
#
# El Gateway escala de 1 a 4 copias (RNF05): la imagen no guarda estado en memoria ni en disco, y lo que las copias deben
# compartir (el contador del límite de peticiones, RNF19) vive en la base de datos.
#
# Las migraciones y el sembrado NO se ejecutan al arrancar el contenedor: con varias copias arrancando a la vez correrían a
# la vez. Se ejecutan con esta misma imagen, a mano o con un Job de Kubernetes, antes de arrancar las copias:
#   php artisan migrate --force           en cada despliegue (también crea la tabla `cache` del límite de peticiones)
#   php artisan migrate --seed --force    UNA sola vez, con ADMIN_EMAIL y ADMIN_PASSWORD en el entorno

FROM php:8.4-apache

# Extensión de MySQL (las demás que pide Laravel ya vienen en la imagen) y unzip, que Composer usa para instalar. El
# php.ini-production deja el modo de producción de PHP (errores sin mostrar al cliente). Sus límites de carga (upload_max_filesize
# de 2 MB y post_max_size de 8 MB) se dejan como están: ni el contrato ni ms-reportes fijan un tamaño máximo para
# POST /importaciones, y no se inventa uno aquí. Si hace falta subirlos, se cambian en servicio.ini (ver más abajo).
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/* \
    && docker-php-ext-install pdo_mysql \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# Primero solo las dependencias: si el código cambia pero composer.lock no, Docker reutiliza esta capa.
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction

# El código (sin lo que excluye .dockerignore) y el autoload optimizado, que también descubre los paquetes (package:discover) y
# genera bootstrap/cache sin los paquetes de desarrollo. No se ejecuta config:cache, route:cache ni optimize: la configuración
# llega al ejecutar el contenedor y quedaría congelada con los valores vacíos del momento de construir la imagen.
# storage/ y bootstrap/cache se crean aquí (.dockerignore deja fuera lo que el equipo trae en ellos) y son de www-data.
COPY . .
RUN composer dump-autoload --optimize --no-dev \
    && mkdir -p storage/app storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs \
    && chown -R www-data:www-data storage bootstrap/cache

# Apache: sirve la carpeta public/ en el puerto PORT (8000 en el clúster), con las reglas de public/.htaccess (mod_rewrite, que
# además deja pasar la cabecera Authorization con el JWT). Sin registro de accesos: la aplicación ya registra cada petición en
# JSON y sin la cadena de consulta (RNF10).
ENV APACHE_DOCUMENT_ROOT=/var/www/html/public \
    PORT=8000
RUN a2enmod rewrite \
    && a2disconf other-vhosts-access-log \
    && sed -ri 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/000-default.conf \
    && sed -ri 's!<VirtualHost \*:80>!<VirtualHost *:${PORT}>!' /etc/apache2/sites-available/000-default.conf \
    && sed -ri '/CustomLog/d' /etc/apache2/sites-available/000-default.conf \
    && sed -ri 's!^Listen 80$!Listen ${PORT}!' /etc/apache2/ports.conf \
    && sed -ri '/<Directory \/var\/www\/>/,/<\/Directory>/ s/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf \
    && printf 'ServerName localhost\nServerTokens Prod\nServerSignature Off\n' > /etc/apache2/conf-enabled/servicio.conf \
    && printf 'expose_php = Off\n' > "$PHP_INI_DIR/conf.d/servicio.ini" \
    && chown -R www-data:www-data /var/run/apache2 /var/lock/apache2 /var/log/apache2

# Valores que no son secretos (los mismos del .env.example, en su versión de producción). Al ejecutar el contenedor llegan:
#   - obligatorias: JWT_SECRET (al menos 32 caracteres, sin valor por defecto), DB_HOST, DB_DATABASE, DB_USERNAME y DB_PASSWORD.
#     Sin JWT_SECRET, /health responde 503 y el Gateway no emite ni acepta tokens. Todas las copias comparten el mismo.
#   - APP_KEY: Laravel la espera, pero el Gateway no cifra nada (ni cookies ni sesiones) y sin ella funcionó en las pruebas. Se
#     define igual y la misma en todas las copias, por si algún día se cifra algo.
#   - para sembrar al primer administrador (solo en el Job de sembrado): ADMIN_EMAIL y ADMIN_PASSWORD.
#   - opcionales: las seis MS_*_URL (por defecto, los nombres del DNS interno de Kubernetes; fuera del clúster hay que
#     definirlas), TRUSTED_PROXIES, RATE_LIMIT_PER_MINUTE, LOGIN_RATE_LIMIT_PER_MINUTE y JWT_TTL_MINUTES.
# CACHE_STORE=database y NO file: el contador del límite de peticiones (RNF19) vive en el almacén de caché, y con varias copias
# (RNF05) solo una tabla compartida hace que cuenten juntas; con file cada copia llevaría su cuenta y el límite real sería de
# hasta cuatro veces lo configurado. La tabla `cache` la crea `php artisan migrate`. Las sesiones no se guardan (el JWT no tiene
# estado) y el Gateway no encola trabajos; QUEUE_CONNECTION es el del .env.example y no hay ningún worker en la imagen.
ENV APP_NAME=api-gateway \
    APP_ENV=production \
    APP_DEBUG=false \
    APP_LOCALE=es \
    APP_FALLBACK_LOCALE=es \
    LOG_CHANNEL=json_stderr \
    LOG_LEVEL=info \
    DB_CONNECTION=mysql \
    DB_PORT=3306 \
    SESSION_DRIVER=array \
    CACHE_STORE=database \
    QUEUE_CONNECTION=database

# Apache corre con www-data (UID 33 en esta imagen), no como root (por eso escucha en el 8000 y no en el 80). USER lo nombra por
# su NÚMERO: con `runAsNonRoot: true` en el securityContext de Kubernetes, el kubelet rechaza una imagen cuyo USER es un nombre,
# porque no puede comprobar que no sea root.
USER 33

EXPOSE 8000

# Docker marca el contenedor como no sano si /health no responde 200. /health NO consulta la base de datos ni los microservicios:
# detecta una configuración que impide atender (JWT_SECRET o JWT_TTL_MINUTES inválidos, una MS_*_URL que no es una URL http(s), o
# una TRUSTED_PROXIES no válida, que hace responder 500 a todo). Con MySQL caído la imagen sigue «sana», aunque el inicio de
# sesión falle: eso lo vigila quien orqueste, no esta sonda.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

# El CMD de la imagen base (apache2-foreground) deja a Apache como proceso principal, y su STOPSIGNAL (SIGWINCH) hace que
# `docker stop` lo detenga de forma ordenada: termina las peticiones en curso y sale con código 0. Con Kubernetes no está
# comprobado: quien escriba los manifiestos debe confirmar que el runtime respeta ese STOPSIGNAL (si envía SIGTERM, Apache
# corta las peticiones en curso) y fijar terminationGracePeriodSeconds.
