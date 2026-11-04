<?php

use App\Support\Roles;

/*
|--------------------------------------------------------------------------
| Mapa de rutas públicas y roles autorizados
|--------------------------------------------------------------------------
|
| Es la tabla de autorización de todo el sistema (D7): lo que no está aquí
| no se reenvía nunca, y un rol que falte o sobre es un permiso mal dado.
| Se transcribe de la columna «Roles» de las Tablas 7 a 12 de la Entrega 2
| (p. 27 a 33), una regla por fila, en el orden de cada tabla:
|
|   - ADM, OPE, VEN y CON son los roles de Roles::*; «Todos» es Roles::TODOS.
|   - Se descarta lo que sigue al «;» en la columna (ms-reportes (interno),
|     ms-inventario (interno)...): son otros servicios que llaman dentro del
|     clúster y no pasan por el Gateway.
|   - Las filas cuya ruta empieza por /internas no se publican (4 filas:
|     /internas/productos/lote, /internas/proveedores/lote,
|     /internas/saldos/carga-inicial y /internas/notificaciones).
|   - Las rutas propias del Gateway (/api/auth/*, /api/usuarios*, /api/roles,
|     Tabla 6) las atiende el propio Gateway y no entran aquí.
|
| La ruta va sin la barra inicial y sin el prefijo /api: es la «ruta interna»
| de las tablas, la misma que recibe el servicio (Tabla 4). `{param}` es un
| único segmento. Si un segmento literal y un `{param}` coinciden en la misma
| posición, gana el literal (por ejemplo lotes/sugerencia-salida).
|
| Son 66 reglas: 11 de ms-catalogo, 9 de ms-proveedores, 23 de ms-inventario,
| 9 de ms-compras, 6 de ms-notificaciones y 8 de ms-reportes.
|
*/

return [

    // Tabla 7: ms-catalogo (11 reglas)
    ['metodo' => 'GET', 'ruta' => 'productos', 'servicio' => 'ms-catalogo', 'roles' => Roles::TODOS],
    ['metodo' => 'GET', 'ruta' => 'productos/{id}', 'servicio' => 'ms-catalogo', 'roles' => Roles::TODOS],
    ['metodo' => 'POST', 'ruta' => 'productos', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]],
    ['metodo' => 'PUT', 'ruta' => 'productos/{id}', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'productos/{id}/inactivar', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'productos/{id}/activar', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]],
    ['metodo' => 'GET', 'ruta' => 'categorias', 'servicio' => 'ms-catalogo', 'roles' => Roles::TODOS],
    ['metodo' => 'GET', 'ruta' => 'categorias/{id}', 'servicio' => 'ms-catalogo', 'roles' => Roles::TODOS],
    ['metodo' => 'POST', 'ruta' => 'categorias', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]],
    ['metodo' => 'PUT', 'ruta' => 'categorias/{id}', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]],
    ['metodo' => 'DELETE', 'ruta' => 'categorias/{id}', 'servicio' => 'ms-catalogo', 'roles' => [Roles::ADM]],

    // Tabla 8: ms-proveedores (9 reglas)
    ['metodo' => 'GET', 'ruta' => 'proveedores', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'proveedores/{id}', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'proveedores', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM]],
    ['metodo' => 'PUT', 'ruta' => 'proveedores/{id}', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'proveedores/{id}/inactivar', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'proveedores/{id}/activar', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM]],
    ['metodo' => 'GET', 'ruta' => 'proveedores/{id}/productos', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'proveedores/{id}/productos', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM]],
    ['metodo' => 'DELETE', 'ruta' => 'proveedores/{id}/productos/{id_producto}', 'servicio' => 'ms-proveedores', 'roles' => [Roles::ADM]],

    // Tabla 9: ms-inventario (23 reglas)
    ['metodo' => 'GET', 'ruta' => 'bodegas', 'servicio' => 'ms-inventario', 'roles' => Roles::TODOS],
    ['metodo' => 'GET', 'ruta' => 'bodegas/{id}', 'servicio' => 'ms-inventario', 'roles' => Roles::TODOS],
    ['metodo' => 'POST', 'ruta' => 'bodegas', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'PUT', 'ruta' => 'bodegas/{id}', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'bodegas/{id}/inactivar', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'bodegas/{id}/activar', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'GET', 'ruta' => 'saldos', 'servicio' => 'ms-inventario', 'roles' => Roles::TODOS],
    ['metodo' => 'GET', 'ruta' => 'saldos/bajo-umbral', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'GET', 'ruta' => 'umbrales', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'PUT', 'ruta' => 'umbrales/{id_producto}', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'movimientos', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'movimientos', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::CON, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'movimientos/{id}', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::CON, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'lotes', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'lotes/sugerencia-salida', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'traslados', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'traslados/{id}/recepcion', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'traslados', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'conteos', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],
    ['metodo' => 'GET', 'ruta' => 'conteos', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'conteos/{id}', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'PUT', 'ruta' => 'conteos/{id}/detalles', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'conteos/{id}/aprobacion', 'servicio' => 'ms-inventario', 'roles' => [Roles::ADM]],

    // Tabla 10: ms-compras (9 reglas)
    ['metodo' => 'GET', 'ruta' => 'ordenes-compra', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'ordenes-compra/{id}', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'ordenes-compra', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM]],
    ['metodo' => 'PUT', 'ruta' => 'ordenes-compra/{id}', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM]],
    ['metodo' => 'PATCH', 'ruta' => 'ordenes-compra/{id}/estado', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM]],
    ['metodo' => 'POST', 'ruta' => 'ordenes-compra/{id}/recepciones', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'ordenes-compra/{id}/recepciones', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'POST', 'ruta' => 'devoluciones-proveedor', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM, Roles::OPE]],
    ['metodo' => 'GET', 'ruta' => 'devoluciones-proveedor', 'servicio' => 'ms-compras', 'roles' => [Roles::ADM, Roles::OPE]],

    // Tabla 11: ms-notificaciones (6 reglas)
    ['metodo' => 'GET', 'ruta' => 'notificaciones', 'servicio' => 'ms-notificaciones', 'roles' => Roles::TODOS],
    ['metodo' => 'POST', 'ruta' => 'notificaciones/{id}/leida', 'servicio' => 'ms-notificaciones', 'roles' => Roles::TODOS],
    ['metodo' => 'GET', 'ruta' => 'preferencias/mia', 'servicio' => 'ms-notificaciones', 'roles' => Roles::TODOS],
    ['metodo' => 'PUT', 'ruta' => 'preferencias/mia', 'servicio' => 'ms-notificaciones', 'roles' => Roles::TODOS],
    ['metodo' => 'GET', 'ruta' => 'configuracion-alertas', 'servicio' => 'ms-notificaciones', 'roles' => [Roles::ADM]],
    ['metodo' => 'PUT', 'ruta' => 'configuracion-alertas', 'servicio' => 'ms-notificaciones', 'roles' => [Roles::ADM]],

    // Tabla 12: ms-reportes (8 reglas)
    ['metodo' => 'GET', 'ruta' => 'reportes/existencias', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM, Roles::CON]],
    ['metodo' => 'GET', 'ruta' => 'reportes/valorizacion', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM, Roles::CON]],
    ['metodo' => 'GET', 'ruta' => 'reportes/rotacion', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM, Roles::CON]],
    ['metodo' => 'GET', 'ruta' => 'reportes/kardex', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM, Roles::CON]],
    ['metodo' => 'GET', 'ruta' => 'indicadores', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM, Roles::CON]],
    ['metodo' => 'POST', 'ruta' => 'importaciones', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM]],
    ['metodo' => 'GET', 'ruta' => 'importaciones', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM]],
    ['metodo' => 'GET', 'ruta' => 'importaciones/{id}', 'servicio' => 'ms-reportes', 'roles' => [Roles::ADM]],

];
