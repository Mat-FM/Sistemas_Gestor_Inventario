<?php

namespace App\Services;

use App\Gateway\GatewayClient;

/** Acceso a ms-reportes a través del Gateway. */
class Reportes
{
    /** Lo que se puede importar y las columnas que cada archivo debe traer (Tabla 13 de la Entrega 2). */
    public const IMPORTABLES = [
        'PRODUCTOS' => ['nombre' => 'Productos', 'columnas' => ['codigo', 'nombre', 'descripcion', 'categoria', 'unidad_medida', 'precio']],
        'PROVEEDORES' => ['nombre' => 'Proveedores', 'columnas' => ['nit', 'razon_social', 'nombre_contacto', 'telefono', 'correo', 'direccion']],
        'STOCK_INICIAL' => ['nombre' => 'Stock inicial', 'columnas' => ['codigo_producto', 'codigo_bodega', 'cantidad', 'codigo_lote', 'fecha_vencimiento']],
    ];

    public function __construct(private readonly GatewayClient $gateway) {}

    /** @return array{productos: list<array<string, mixed>>, valor_total: int|float} */
    public function valorizacion(): array
    {
        $respuesta = $this->gateway->get('reportes/valorizacion');

        return [
            'productos' => $respuesta['productos'] ?? [],
            'valor_total' => $respuesta['valor_total'] ?? 0,
        ];
    }

    /**
     * El panel de indicadores (RF14). Lo calcula ms-reportes con datos de inventario, catálogo y compras.
     *
     * @return array{valor_total: int|float, productos_bajo_umbral: int, productos_agotados: int, proximos_a_vencer: int, mayor_rotacion: list<array<string, mixed>>, ordenes_pendientes: int}
     */
    public function indicadores(): array
    {
        $respuesta = $this->gateway->get('indicadores') ?? [];

        return [
            'valor_total' => $respuesta['valor_total'] ?? 0,
            'productos_bajo_umbral' => (int) ($respuesta['productos_bajo_umbral'] ?? 0),
            'productos_agotados' => (int) ($respuesta['productos_agotados'] ?? 0),
            'proximos_a_vencer' => (int) ($respuesta['proximos_a_vencer'] ?? 0),
            'mayor_rotacion' => $respuesta['mayor_rotacion'] ?? [],
            'ordenes_pendientes' => (int) ($respuesta['ordenes_pendientes'] ?? 0),
        ];
    }

    /** @return list<array<string, mixed>> id_producto, codigo, nombre, id_categoria, id_bodega, bodega, cantidad_disponible */
    public function existencias(array $filtros = []): array
    {
        return $this->gateway->get('reportes/existencias', $filtros) ?? [];
    }

    /** @return array{productos: list<array<string, mixed>>, valor_total: int|float} */
    public function valorizacionDe(array $filtros = []): array
    {
        $respuesta = $this->gateway->get('reportes/valorizacion', $filtros) ?? [];

        return ['productos' => $respuesta['productos'] ?? [], 'valor_total' => $respuesta['valor_total'] ?? 0];
    }

    /** @return array{mayor_rotacion: list<array<string, mixed>>, menor_rotacion: list<array<string, mixed>>} */
    public function rotacion(string $desde, string $hasta, int $limite = 10): array
    {
        $respuesta = $this->gateway->get('reportes/rotacion', ['fecha_desde' => $desde, 'fecha_hasta' => $hasta, 'limite' => $limite]) ?? [];

        return ['mayor_rotacion' => $respuesta['mayor_rotacion'] ?? [], 'menor_rotacion' => $respuesta['menor_rotacion'] ?? []];
    }

    /** @return list<array<string, mixed>> Los movimientos del kardex, del más reciente al más antiguo, sin paginar. */
    public function kardex(array $filtros = []): array
    {
        return $this->gateway->get('reportes/kardex', $filtros) ?? [];
    }

    /** @return array{cuerpo: string, tipo: string, disposicion: string|null} */
    public function archivo(string $reporte, array $filtros, string $formato): array
    {
        return $this->gateway->descargar("reportes/$reporte", $filtros + ['formato' => $formato]);
    }

    /** @return array{datos: list<array<string, mixed>>, meta: array<string, mixed>} Las importaciones, de la más reciente a la más antigua. */
    public function importaciones(array $filtros = []): array
    {
        $respuesta = $this->gateway->get('importaciones', $filtros + ['por_pagina' => 20]) ?? [];

        return ['datos' => $respuesta['datos'] ?? [], 'meta' => $respuesta['meta'] ?? ['pagina' => 1, 'por_pagina' => 20, 'total' => 0]];
    }

    /** @return array<string, mixed> Una importación con sus errores por fila. */
    public function importacion(int $id): array
    {
        return $this->gateway->get("importaciones/$id");
    }

    /** @return array<string, mixed> La importación ya procesada, con sus errores. */
    public function importar(string $tipo, string $contenido, string $nombreArchivo): array
    {
        return $this->gateway->subir('importaciones', ['tipo' => $tipo], 'archivo', $contenido, $nombreArchivo)->cuerpo;
    }
}
