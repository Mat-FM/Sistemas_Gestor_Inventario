<?php

namespace App\Http\Controllers;

use App\Gateway\GatewayException;
use App\Gateway\Intento;
use App\Services\Catalogo;
use App\Services\Inventario;
use App\Services\Nombres;
use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\Http\Request;
use Illuminate\View\View;

/** Consulta de existencias por producto y bodega, con búsqueda por nombre o código (RF05, RF12). */
class StockController extends Controller
{
    public function index(
        Request $request,
        Sesion $sesion,
        Catalogo $catalogo,
        Inventario $inventario,
        Nombres $nombres,
    ): View {
        $operador = $sesion->rol() === Roles::OPERADOR;
        if ($operador && $sesion->idBodega() === null) {
            return view('stock.index', ['sinBodega' => true]);
        }

        $busqueda = trim((string) $request->query('q', ''));
        $idBodega = $operador ? $sesion->idBodega() : ($request->integer('bodega') ?: null);
        [$bodegas] = Intento::de(fn () => $nombres->bodegas());

        $datos = [
            'sinBodega' => false,
            'busqueda' => $busqueda,
            'idBodega' => $idBodega,
            'bodegas' => $bodegas ?? [],
            'puedeElegirBodega' => ! $operador,
            'puedeOperar' => in_array($sesion->rol(), [Roles::ADMINISTRADOR, Roles::OPERADOR], true),
            'meta' => null,
        ];

        return view('stock.index', array_merge($datos, $busqueda !== ''
            ? $this->buscar($busqueda, $idBodega, $catalogo, $inventario)
            : $this->listar($request->integer('pagina', 1), $idBodega, $inventario, $nombres)));
    }

    /** @return array{tarjetas: list<array<string, mixed>>, hayMas: bool, error: bool} */
    private function buscar(string $texto, ?int $idBodega, Catalogo $catalogo, Inventario $inventario): array
    {
        try {
            $productos = $catalogo->buscar($texto);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);

            return ['tarjetas' => [], 'hayMas' => false, 'error' => true];
        }

        $saldos = $inventario->saldosDeProductos(array_map(static fn ($p) => (int) $p['id_producto'], $productos), $idBodega);
        $nombresDeBodega = $this->nombresDeBodega();

        $tarjetas = [];
        foreach ($productos as $producto) {
            $respuesta = $saldos[(int) $producto['id_producto']] ?? null;
            $tarjetas[] = [
                'producto' => $producto,
                'disponible' => ! $respuesta instanceof GatewayException && $respuesta !== null,
                'filas' => $respuesta instanceof GatewayException || $respuesta === null ? [] : array_map(
                    static fn (array $saldo) => [
                        'id_bodega' => (int) $saldo['id_bodega'],
                        'bodega' => $nombresDeBodega[(int) $saldo['id_bodega']] ?? 'Bodega #'.$saldo['id_bodega'],
                        'cantidad' => $saldo['cantidad_disponible'],
                    ],
                    $respuesta['datos'],
                ),
            ];
            $tarjetas[array_key_last($tarjetas)]['total'] = array_sum(array_column($tarjetas[array_key_last($tarjetas)]['filas'], 'cantidad'));
        }

        return ['tarjetas' => $tarjetas, 'hayMas' => count($productos) >= Catalogo::MAXIMO_RESULTADOS, 'error' => false];
    }

    /** @return array{tarjetas: list<array<string, mixed>>, hayMas: bool, error: bool, meta: array<string, mixed>|null} */
    private function listar(int $pagina, ?int $idBodega, Inventario $inventario, Nombres $nombres): array
    {
        try {
            $respuesta = $inventario->saldos(['id_bodega' => $idBodega, 'pagina' => max(1, $pagina)]);
        } catch (GatewayException $e) {
            Intento::propagarSiAfectaATodo($e);

            return ['tarjetas' => [], 'hayMas' => false, 'error' => true, 'meta' => null];
        }

        $grupos = [];
        foreach ($nombres->conNombres($respuesta['datos']) as $saldo) {
            $id = (int) $saldo['id_producto'];
            $grupos[$id]['producto'] ??= ['id_producto' => $id] + $saldo['producto'];
            $grupos[$id]['disponible'] = true;
            $grupos[$id]['filas'][] = [
                'id_bodega' => (int) $saldo['id_bodega'],
                'bodega' => $saldo['bodega'],
                'cantidad' => $saldo['cantidad_disponible'],
            ];
        }
        foreach ($grupos as &$grupo) {
            $grupo['total'] = array_sum(array_column($grupo['filas'], 'cantidad'));
        }

        return ['tarjetas' => array_values($grupos), 'hayMas' => false, 'error' => false, 'meta' => $respuesta['meta']];
    }

    /** @return array<int, string> */
    private function nombresDeBodega(): array
    {
        [$bodegas] = Intento::de(fn () => app(Nombres::class)->bodegas());

        return array_map(static fn (array $bodega) => $bodega['nombre'], $bodegas ?? []);
    }
}
