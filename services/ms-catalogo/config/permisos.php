<?php

/*
 * Quién puede llamar a cada ruta. Es la misma matriz que aplica el Gateway (Tabla 7 de la Entrega 2, api-gateway/config/gateway_routes.php),
 * repetida aquí para que el servicio no dependa de que nadie le salte el Gateway (defensa en profundidad, RNF07, RNF09): un rol que no
 * figura recibe 403 SIN_PERMISO antes de que la ruta haga nada (App\Http\Middleware\ExigirRol). La clave es «MÉTODO ruta» tal como la
 * declara Laravel. tests/Feature/PermisosRolesTest.php exige una entrada por cada ruta y la compara con la del Gateway.
 *
 * `null` = no se restringe aquí. Una petición sin X-User-Rol es una llamada interna (ms-inventario, ms-compras, ms-reportes) y tampoco se
 * restringe nunca.
 */

$todos = ['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'];
$adm = ['ADMINISTRADOR'];

return [
    'rutas' => [
        'GET categorias' => $todos,
        'POST categorias' => $adm,
        'GET categorias/{id}' => $todos,
        'PUT categorias/{id}' => $adm,
        'DELETE categorias/{id}' => $adm,
        'GET productos' => $todos,
        'POST productos' => $adm,
        'GET productos/{id}' => $todos,
        'PUT productos/{id}' => $adm,
        'POST productos/{id}/inactivar' => $adm,
        'POST productos/{id}/activar' => $adm,
        // Ruta interna de ms-reportes (no pasa por el Gateway): importar productos es de ADMINISTRADOR y ms-reportes reenvía su identidad.
        'POST internas/productos/lote' => $adm,
    ],
];
