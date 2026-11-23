<?php

/*
 * Quién puede llamar a cada ruta. Es la misma matriz que aplica el Gateway (Tabla 8 de la Entrega 2, api-gateway/config/gateway_routes.php),
 * repetida aquí para que el servicio no dependa de que nadie le salte el Gateway (defensa en profundidad, RNF07, RNF09): un rol que no
 * figura recibe 403 SIN_PERMISO antes de que la ruta haga nada (App\Http\Middleware\ExigirRol). La clave es «MÉTODO ruta» tal como la
 * declara Laravel. tests/Feature/PermisosRolesTest.php exige una entrada por cada ruta y la compara con la del Gateway.
 *
 * `null` = no se restringe aquí. Una petición sin X-User-Rol es una llamada interna (ms-catalogo para el filtro por proveedor, ms-compras)
 * y tampoco se restringe nunca.
 */

$lectura = ['ADMINISTRADOR', 'OPERADOR_BODEGA'];
$adm = ['ADMINISTRADOR'];

return [
    'rutas' => [
        'GET proveedores' => $lectura,
        'POST proveedores' => $adm,
        'GET proveedores/{id}' => $lectura,
        'PUT proveedores/{id}' => $adm,
        'POST proveedores/{id}/inactivar' => $adm,
        'POST proveedores/{id}/activar' => $adm,
        'GET proveedores/{id}/productos' => $lectura,
        'POST proveedores/{id}/productos' => $adm,
        'DELETE proveedores/{id}/productos/{idProducto}' => $adm,
        // Ruta interna de ms-reportes (no pasa por el Gateway): importar proveedores es de ADMINISTRADOR y ms-reportes reenvía su identidad.
        'POST internas/proveedores/lote' => $adm,
    ],
];
