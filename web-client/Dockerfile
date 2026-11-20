# Imagen del web-client (RNF03): Laravel 13 con Blade y Bootstrap, servido con Apache y PHP 8.4.
#
# Construir (desde web-client):  docker build -t web-client .
# La configuración llega por variables de entorno (RNF14); la imagen no lleva ningún .env ni ningún secreto.
#
# El cliente web no tiene base de datos (la sesión viaja cifrada en una cookie y el caché es de archivos), así que cualquier copia
# atiende a cualquier usuario y se pueden poner varias. Eso exige UNA condición: todas las copias llevan la misma APP_KEY. Con
# otra, una copia no puede leer la cookie de sesión que hizo la otra y el usuario vuelve al inicio de sesión.
#
# Solo habla con el API Gateway (RNF21): su única dirección de servicio es API_GATEWAY_URL.

FROM php:8.4-apache

# unzip lo usa Composer para instalar. El php.ini-production deja el modo de producción de PHP (errores sin mostrar al cliente).
# Sus límites de carga (upload_max_filesize de 2 MB y post_max_size de 8 MB) se dejan como están: la importación masiva
# valida archivos de hasta 2 MB (unas 20 000 filas), que es lo mismo que acepta el Gateway; ms-reportes no fija otro tamaño.
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# Primero solo las dependencias: si el código cambia pero composer.lock no, Docker reutiliza esta capa.
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction

# El código (sin lo que excluye .dockerignore) y el autoload optimizado, que también descubre los paquetes y genera bootstrap/cache
# sin los de desarrollo. No se ejecuta config:cache ni optimize: la configuración llega al ejecutar el contenedor y quedaría
# congelada con los valores vacíos del momento de construir la imagen. storage/ y bootstrap/cache son del usuario que corre Apache.
COPY . .
RUN composer dump-autoload --optimize --no-dev \
    && mkdir -p storage/app storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs \
    && chown -R www-data:www-data storage bootstrap/cache

# Apache: sirve public/ en el puerto PORT (8000), con las reglas de public/.htaccess (mod_rewrite). Sin registro de accesos: la
# aplicación ya registra cada petición en JSON y sin la cadena de consulta (RNF10).
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

# Valores que no son secretos, en su versión de producción (el .env.example trae APP_ENV=local y APP_DEBUG=true para trabajar).
# Al ejecutar el contenedor llegan:
#   - obligatoria: APP_KEY (la misma en todas las copias; `php artisan key:generate --show` la genera). Sin ella Laravel no puede
#     cifrar la sesión y toda petición responde 500.
#   - API_GATEWAY_URL: por defecto, el nombre del Service del Gateway en Kubernetes; fuera del clúster hay que definirla.
#   - opcionales: TRUSTED_PROXIES (IP o CIDR del Ingress; sin ella el Gateway ve siempre la misma IP y su límite de inicios de
#     sesión por IP se vuelve global), API_GATEWAY_TIMEOUT, SESSION_SECURE_COOKIE (true cuando el Ingress sirve HTTPS) y LOG_LEVEL.
# Sesión en cookie, caché en archivos y sin base de datos: nada de esto se comparte entre copias más que la APP_KEY.
ENV APP_ENV=production \
    APP_DEBUG=false \
    APP_LOCALE=es \
    APP_FALLBACK_LOCALE=es \
    APP_TIMEZONE=America/Bogota \
    API_GATEWAY_URL=http://api-gateway:8000 \
    LOG_CHANNEL=json_stderr \
    SESSION_DRIVER=cookie \
    SESSION_LIFETIME=60 \
    SESSION_ENCRYPT=true \
    CACHE_STORE=file \
    QUEUE_CONNECTION=sync \
    DB_CONNECTION=null

# Usuario sin privilegios, indicado por su UID (33 = www-data) y no por su nombre: con runAsNonRoot, Kubernetes solo acepta un
# USER numérico. Apache escucha en el 8000 y no en el 80 por eso mismo.
USER 33
EXPOSE 8000

# /up responde 200 cuando Laravel arranca; no consulta al Gateway (una caída del Gateway no debe reiniciar este contenedor).
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD php -r "exit(@file_get_contents('http://127.0.0.1:' . (getenv('PORT') ?: 8000) . '/up') === false ? 1 : 0);"
