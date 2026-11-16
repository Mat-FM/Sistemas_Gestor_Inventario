# Imagen de ms-proveedores (RNF03): Laravel servido con Apache y PHP 8.4.
#
# Construir (desde services/ms-proveedores):  docker build -t ms-proveedores .
# La configuración llega por variables de entorno (RNF14); la imagen no lleva ningún .env.

FROM php:8.4-apache

# Extensión de MySQL (las demás que pide Laravel ya vienen en la imagen) y unzip, que Composer usa para instalar.
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

# El código (sin lo que excluye .dockerignore) y el autoload optimizado (que también descubre los paquetes).
COPY . .
RUN composer dump-autoload --optimize --no-dev \
    && chown -R www-data:www-data storage bootstrap/cache

# Apache: sirve la carpeta public/ en el puerto PORT, con las reglas de public/.htaccess (mod_rewrite). Sin registro
# de accesos: la aplicación ya registra cada petición en JSON y sin la cadena de consulta (RNF10).
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

# Valores que no son secretos (los mismos del .env.example). APP_KEY y la conexión a la base (DB_HOST, DB_DATABASE,
# DB_USERNAME, DB_PASSWORD) se pasan al ejecutar el contenedor.
ENV APP_NAME=ms-proveedores \
    APP_ENV=production \
    APP_DEBUG=false \
    APP_LOCALE=es \
    APP_FALLBACK_LOCALE=es \
    LOG_CHANNEL=json_stderr \
    LOG_LEVEL=info \
    DB_CONNECTION=mysql \
    DB_PORT=3306 \
    SESSION_DRIVER=array \
    CACHE_STORE=file \
    QUEUE_CONNECTION=sync

# Apache corre con el usuario www-data, no como root (por eso escucha en el 8000 y no en el 80).
USER www-data

EXPOSE 8000

# Docker marca el contenedor como no sano si /health no responde 200 (MySQL caído).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

# El CMD de la imagen base (apache2-foreground) deja a Apache como proceso principal.
