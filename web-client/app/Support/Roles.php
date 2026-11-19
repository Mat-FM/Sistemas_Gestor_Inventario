<?php

namespace App\Support;

/** Los cuatro roles del Gateway y lo que cada uno ve en el menú. El Gateway sigue siendo quien autoriza cada petición. */
final class Roles
{
    public const ADMINISTRADOR = 'ADMINISTRADOR';

    public const OPERADOR = 'OPERADOR_BODEGA';

    public const VENDEDOR = 'VENDEDOR';

    public const CONTADOR = 'CONTADOR';

    public const NOMBRES = [
        self::ADMINISTRADOR => 'Administrador',
        self::OPERADOR => 'Operador de bodega',
        self::VENDEDOR => 'Vendedor',
        self::CONTADOR => 'Contador',
    ];

    private const MENU = [
        self::ADMINISTRADOR => ['inicio', 'stock', 'movimientos.index', 'traslados.index', 'compras.ordenes.index', 'reportes.index', 'administrar'],
        self::OPERADOR => ['inicio', 'stock', 'movimientos.index', 'traslados.index', 'compras.ordenes.index'],
        self::VENDEDOR => ['inicio'],
        self::CONTADOR => ['inicio', 'stock', 'movimientos.index', 'reportes.index'],
    ];

    /** Etiquetas e iconos (Bootstrap Icons) por entrada de menú; algunas cambian según el rol. */
    private const ENTRADAS = [
        'inicio' => ['Inicio', 'house-door'],
        'stock' => ['Stock', 'boxes'],
        'movimientos.index' => ['Movimientos', 'arrow-left-right'],
        'traslados.index' => ['Traslados', 'truck'],
        'compras.ordenes.index' => ['Compras', 'cart3'],
        'reportes.index' => ['Reportes', 'graph-up'],
        'administrar' => ['Más', 'three-dots'],
    ];

    /** Las secciones de administración (solo el administrador): ruta, etiqueta, icono y descripción para la pantalla «Administrar». */
    public const ADMINISTRACION = [
        ['ruta' => 'productos.index', 'etiqueta' => 'Productos', 'icono' => 'tags', 'detalle' => 'Crear, editar y dar de baja productos'],
        ['ruta' => 'categorias.index', 'etiqueta' => 'Categorías', 'icono' => 'diagram-3', 'detalle' => 'Ordenar los productos por tipo'],
        ['ruta' => 'proveedores.index', 'etiqueta' => 'Proveedores', 'icono' => 'shop', 'detalle' => 'Quién nos surte y qué productos'],
        ['ruta' => 'bodegas.index', 'etiqueta' => 'Bodegas', 'icono' => 'building', 'detalle' => 'Dónde se guarda la mercancía'],
        ['ruta' => 'umbrales.index', 'etiqueta' => 'Stock mínimo', 'icono' => 'exclamation-triangle', 'detalle' => 'Cuándo avisar que un producto escasea'],
        ['ruta' => 'usuarios.index', 'etiqueta' => 'Usuarios', 'icono' => 'people', 'detalle' => 'Quién entra al sistema y con qué rol'],
        ['ruta' => 'alertas.edit', 'etiqueta' => 'Alertas', 'icono' => 'bell', 'detalle' => 'Con cuánta anticipación avisar los vencimientos'],
        ['ruta' => 'importaciones.index', 'etiqueta' => 'Importar datos', 'icono' => 'file-earmark-arrow-up', 'detalle' => 'Cargar productos, proveedores o stock inicial desde un archivo'],
    ];

    /**
     * El menú inferior del celular: cinco entradas como máximo. El administrador deja «Compras» dentro de «Más».
     *
     * @return list<array{ruta: string, etiqueta: string, icono: string}>
     */
    public static function menuMovil(?string $rol): array
    {
        return array_values(array_filter(
            self::menu($rol),
            static fn (array $entrada) => ! ($rol === self::ADMINISTRADOR && in_array($entrada['ruta'], ['compras.ordenes.index', 'reportes.index'], true)),
        ));
    }

    /** @return list<array{ruta: string, etiqueta: string, icono: string}> */
    public static function menu(?string $rol): array
    {
        $entradas = [];
        foreach (self::MENU[$rol] ?? [] as $ruta) {
            [$etiqueta, $icono] = self::ENTRADAS[$ruta];
            if ($ruta === 'inicio' && $rol === self::VENDEDOR) {
                [$etiqueta, $icono] = ['Buscar', 'search'];
            }
            if ($ruta === 'stock' && $rol === self::CONTADOR) {
                $etiqueta = 'Existencias';
            }
            $entradas[] = ['ruta' => $ruta, 'etiqueta' => $etiqueta, 'icono' => $icono];
        }

        return $entradas;
    }

    /** Reportes y auditoría, dentro de «Más» para el administrador. */
    public const REPORTES = [
        ['ruta' => 'reportes.index', 'etiqueta' => 'Reportes y auditoría', 'icono' => 'graph-up', 'detalle' => 'Existencias, valorización, rotación y kardex, con descarga en CSV y PDF'],
    ];

    /** Los conteos físicos: el operador los encuentra en «Stock» y el administrador dentro de «Más». */
    public const CONTEOS = [
        ['ruta' => 'conteos.index', 'etiqueta' => 'Conteos físicos', 'icono' => 'clipboard-check', 'detalle' => 'Contar lo que hay en la bodega y ajustar el inventario'],
    ];

    /** Lo de «Compras» que el administrador encuentra dentro de «Más». */
    public const COMPRAS = [
        ['ruta' => 'compras.ordenes.index', 'etiqueta' => 'Órdenes de compra', 'icono' => 'cart3', 'detalle' => 'Pedir a proveedores y recibir la mercancía'],
        ['ruta' => 'compras.devoluciones.index', 'etiqueta' => 'Devoluciones a proveedor', 'icono' => 'arrow-return-left', 'detalle' => 'Mercancía que se regresa y sale del inventario'],
    ];

    /** @return list<array{ruta: string, etiqueta: string, icono: string, detalle: string}> */
    public static function administracion(?string $rol): array
    {
        return $rol === self::ADMINISTRADOR ? self::ADMINISTRACION : [];
    }

    public static function nombre(?string $rol): string
    {
        return self::NOMBRES[$rol] ?? 'Usuario';
    }
}
