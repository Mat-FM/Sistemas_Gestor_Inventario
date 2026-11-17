@extends('layouts.app')

@section('titulo', 'Kardex')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Kardex', 'volver' => route('reportes.index'), 'textoVolver' => 'Reportes'])

    <form method="get" class="row g-2 mb-3">
        <div class="col-12"><select class="form-select" name="producto" aria-label="Producto"><option value="">Todos los productos</option>@foreach ($productos as $id => $nombre)<option value="{{ $id }}" @selected($filtros['id_producto'] === $id)>{{ $nombre }}</option>@endforeach</select></div>
        <div class="col-6"><select class="form-select" name="bodega" aria-label="Bodega"><option value="">Todas las bodegas</option>@foreach ($bodegas as $id => $b)<option value="{{ $id }}" @selected($filtros['id_bodega'] === $id)>{{ $b['nombre'] }}</option>@endforeach</select></div>
        <div class="col-6"><select class="form-select" name="tipo" aria-label="Tipo de movimiento"><option value="">Todos los tipos</option>@foreach (\App\Support\Formato::TIPOS as $codigo => [$nombre])<option value="{{ $codigo }}" @selected($tipo === $codigo)>{{ $nombre }}</option>@endforeach</select></div>
        @if ($usuarios !== null)
            <div class="col-12"><select class="form-select" name="usuario" aria-label="Usuario"><option value="">Todos los usuarios</option>@foreach ($usuarios as $id => $nombre)<option value="{{ $id }}" @selected($filtros['id_usuario'] === $id)>{{ $nombre }}</option>@endforeach</select></div>
        @endif
        <div class="col-6"><label class="form-label small mb-1" for="desde">Desde</label><input class="form-control" type="date" id="desde" name="desde" value="{{ $filtros['fecha_desde'] }}"></div>
        <div class="col-6"><label class="form-label small mb-1" for="hasta">Hasta</label><input class="form-control" type="date" id="hasta" name="hasta" value="{{ $filtros['fecha_hasta'] }}"></div>
        <div class="col-12"><button class="btn btn-outline-primary w-100">Filtrar</button></div>
    </form>
    @include('partials.descargas', ['ruta' => 'reportes.kardex'])

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos generar el kardex. Si hay muchos movimientos, acota por producto, bodega o fechas y vuelve a intentar.'])
        @elseif (! count($filas))
            <div class="nada">No hay movimientos con ese filtro.</div>
        @else
            @foreach ($filas as $m)
                @php($signo = \App\Support\Formato::signo($m['tipo']) ?: ($m['cantidad'] <=> 0))
                <div class="fila-dato align-items-start">
                    <div class="min-w-0">
                        <div class="fw-semibold">{{ $m['nombre'] }}</div>
                        <div class="small text-suave">{{ \App\Support\Formato::tipo($m['tipo']) }} · {{ $m['bodega'] }} · {{ \App\Support\Formato::fecha($m['fecha']) }} · usuario {{ $m['id_usuario'] }}</div>
                        @if (! empty($m['documento_referencia']) || ! empty($m['observacion']))<div class="small text-suave">{{ $m['documento_referencia'] }} {{ $m['observacion'] }}</div>@endif
                    </div>
                    <div class="text-end"><div class="cant {{ $signo > 0 ? 'suma' : ($signo < 0 ? 'resta' : '') }}">{{ $signo > 0 ? '+' : ($signo < 0 ? '−' : '') }}{{ \App\Support\Formato::numero(abs($m['cantidad'])) }}</div><div class="small text-suave">quedan {{ \App\Support\Formato::numero($m['saldo_resultante']) }}</div></div>
                </div>
            @endforeach
            @if ($total > $filasEnPantalla)
                <p class="small text-suave text-center mt-3 mb-0">Mostramos los {{ $filasEnPantalla }} más recientes de {{ \App\Support\Formato::numero($total) }}. Descarga el CSV o el PDF para verlos todos.</p>
            @endif
        @endif
    </div>
@endsection
