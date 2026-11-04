<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Primer administrador
    |--------------------------------------------------------------------------
    |
    | Solo un administrador crea usuarios, así que sin este nadie podría entrar.
    | Lo crea el AdminSeeder con cambio de contraseña pendiente. Las variables
    | se leen aquí y en ningún otro sitio: el resto del código usa config().
    |
    */

    'admin' => [
        'correo' => env('ADMIN_EMAIL'),
        'contrasena' => env('ADMIN_PASSWORD'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Servicios
    |--------------------------------------------------------------------------
    |
    | Las claves son los nombres que usa config/gateway_routes.php. Las URLs
    | salen del entorno (RNF14); el valor por defecto es el nombre del DNS
    | interno de Kubernetes, el mismo que trae .env.example.
    |
    */

    'services' => [
        'ms-catalogo' => env('MS_CATALOGO_URL', 'http://ms-catalogo:8000'),
        'ms-proveedores' => env('MS_PROVEEDORES_URL', 'http://ms-proveedores:8000'),
        'ms-inventario' => env('MS_INVENTARIO_URL', 'http://ms-inventario:3000'),
        'ms-compras' => env('MS_COMPRAS_URL', 'http://ms-compras:3000'),
        'ms-notificaciones' => env('MS_NOTIFICACIONES_URL', 'http://ms-notificaciones:5000'),
        'ms-reportes' => env('MS_REPORTES_URL', 'http://ms-reportes:5000'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Tiempo máximo de espera
    |--------------------------------------------------------------------------
    |
    | Segundos que el Gateway espera la respuesta de un servicio antes de
    | responder 503. Es una regla del contrato, no un ajuste de despliegue.
    |
    */

    'timeout_seconds' => 3,

    /*
    |--------------------------------------------------------------------------
    | Sesión (RNF07)
    |--------------------------------------------------------------------------
    |
    | Secreto de firma del JWT (HS256, al menos 32 caracteres: JwtService lo
    | exige) y vigencia en minutos. El secreto no tiene valor por defecto: sin
    | él la aplicación no emite ni acepta tokens.
    |
    */

    'jwt' => [
        'secret' => env('JWT_SECRET'),
        'ttl_minutes' => (int) env('JWT_TTL_MINUTES', 60),
    ],

    /*
    |--------------------------------------------------------------------------
    | Límite de peticiones (RNF19)
    |--------------------------------------------------------------------------
    |
    | Peticiones por minuto por usuario autenticado y por dirección IP en el
    | inicio de sesión.
    |
    */

    'rate_limit' => [
        'por_usuario' => (int) env('RATE_LIMIT_PER_MINUTE', 100),
        'login_por_ip' => (int) env('LOGIN_RATE_LIMIT_PER_MINUTE', 10),
    ],

    /*
    |--------------------------------------------------------------------------
    | Proxies de confianza
    |--------------------------------------------------------------------------
    |
    | IP o CIDR (separados por comas) de los proxies cuyas cabeceras
    | X-Forwarded-For, -Host, -Port y -Proto se aceptan; vacía, no se confía en
    | ninguno. «*» se rechaza. La interpreta App\Http\Middleware\ConfiarEnProxies.
    |
    */

    'trusted_proxies' => env('TRUSTED_PROXIES', ''),

];
