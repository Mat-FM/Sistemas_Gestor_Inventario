@extends('layouts.app')

@section('titulo', 'Compras')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Compras', 'accion' => $puedeCrear ? route('compras.ordenes.create') : null, 'textoAccion' => 'Nueva orden'])
    @include('partials.pestanas-compras', ['activa' => 'ordenes'])

    <form method="get" class="d-flex flex-wrap gap-2 mb-3">
        <select class="form-select flex-fill" style="min-width:10rem" name="estado" aria-label="Estado">
            <option value="">Todos los estados</option>
            @foreach (\App\Support\Formato::ESTADOS_DE_ORDEN as $codigo => [$nombre])<option value="{{ $codigo }}" @selected($estado === $codigo)>{{ $nombre }}</option>@endforeach
        </select>
        @if ($esOperador)
            <select class="form-select flex-fill" style="min-width:10rem" name="todas" aria-label="Bodegas">
                <option value="0" @selected($soloMiBodega)>Las de mi bodega</option>
                <option value="1" @selected(! $soloMiBodega)>De todas las bodegas</option>
            </select>
        @endif
        <button class="btn btn-outline-primary px-4">Filtrar</button>
    </form>

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar las órdenes.'])
        @elseif (! count($filas))
            <div class="nada">No hay órdenes con ese filtro.@if ($puedeCrear) <a href="{{ route('compras.ordenes.create') }}">Crea la primera.</a>@endif</div>
        @else
            @foreach ($filas as $o)
                <a class="fila-dato text-decoration-none text-body" href="{{ route('compras.ordenes.show', $o['id_orden']) }}">
                    <div class="min-w-0">
                        <div class="fw-semibold">{{ $o['numero'] }} · {{ $o['proveedor'] }}</div>
                        <div class="small text-suave">Llega a {{ $o['bodega_destino'] }} · se espera el {{ \App\Support\Formato::dia($o['fecha_esperada']) }} · {{ \App\Support\Formato::moneda($o['total']) }}</div>
                    </div>
                    <div class="text-end flex-shrink-0">@include('partials.estado-orden', ['estado' => $o['estado']])</div>
                </a>
            @endforeach
        @endif
    </div>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
@endsection
