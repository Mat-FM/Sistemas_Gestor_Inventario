@extends('layouts.app')

@section('titulo', 'Valorización')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Valorización', 'volver' => route('reportes.index'), 'textoVolver' => 'Reportes'])

    <form method="get" class="d-flex gap-2 mb-3">
        <select class="form-select" name="bodega" aria-label="Bodega">
            <option value="">Todas las bodegas</option>
            @foreach ($bodegas as $id => $b)<option value="{{ $id }}" @selected($filtros['id_bodega'] === $id)>{{ $b['nombre'] }}</option>@endforeach
        </select>
        <button class="btn btn-outline-primary px-4">Filtrar</button>
    </form>
    @include('partials.descargas', ['ruta' => 'reportes.valorizacion'])

    @unless ($fallo)
        <section class="tarjeta"><div class="small text-suave">Valor del inventario</div><div class="cifra">{{ \App\Support\Formato::moneda($valorTotal) }}</div><div class="small text-suave">Cantidad en existencia por el precio de lista de cada producto.</div></section>
    @endunless
    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos generar el reporte.'])
        @elseif (! count($productos))
            <div class="nada">No hay productos con existencias.</div>
        @else
            @foreach ($productos as $p)
                <div class="fila-dato">
                    <div class="min-w-0"><div class="fw-semibold">{{ $p['nombre'] }}</div><div class="small text-suave">{{ \App\Support\Formato::numero($p['cantidad']) }} × {{ \App\Support\Formato::moneda($p['precio']) }}</div></div>
                    <span class="cant">{{ \App\Support\Formato::moneda($p['valor']) }}</span>
                </div>
            @endforeach
        @endif
    </div>
@endsection
