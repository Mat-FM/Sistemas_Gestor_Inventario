<?php

/*
|--------------------------------------------------------------------------
| API Gateway
|--------------------------------------------------------------------------
|
| El cliente web solo habla con el Gateway (RNF21): esta es la única dirección de servicio que conoce (RNF14). El plazo
| es mayor que los 3 s que el Gateway espera a cada microservicio, para recibir su 503 en vez de cortar antes.
|
*/

return [
    'url' => rtrim((string) env('API_GATEWAY_URL', 'http://localhost:8000'), '/'),
    'timeout' => (int) env('API_GATEWAY_TIMEOUT', 5),

    // IP o CIDR (separados por comas) de los proxies que ponen X-Forwarded-For delante de este servicio (el Ingress del clúster).
    // Vacío: no se confía en ninguno. Nunca «*»: ver App\Http\Middleware\ConfiarEnProxies.
    'trusted_proxies' => env('TRUSTED_PROXIES', ''),
];
