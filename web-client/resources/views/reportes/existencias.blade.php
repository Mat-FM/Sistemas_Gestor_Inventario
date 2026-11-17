@extends('layouts.app')

@section('titulo', 'Existencias')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Existencias', 'volver' => route('reportes.index'), 'textoVolver' => 'Reportes'])

    <form method="get" class="d-flex flex-wrap gap-2 mb-3">
        <select class="form-select flex-fill" style="min-width:10rem" name="bodega" aria-label="Bodega">
            <option value="">Todas las bodegas</option>
            @foreach ($bodegas as $id => $b)<option value="{{ $id }}" @selected($filtros['id_bodega'] === $id)>{{ $b['nombre'] }}</option>@endforeach
        </select>
        <select class="form-select flex-fill" style="min-width:10rem" name="categoria" aria-label="Categoría">
            <option value="">Todas las categorías</option>
            @foreach ($categorias as $id => $c)<option value="{{ $id }}" @selected($filtros['id_categoria'] === $id)>{{ $c['nombre'] }}</option>@endforeach
        </select>
        <button class="btn btn-outline-primary px-4">Filtrar</button>
    </form>
    @include('partials.descargas', ['ruta' => 'reportes.existencias'])

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos generar el reporte.'])
        @elseif (! count($filas))
            <div class="nada">No hay existencias con ese filtro.</div>
        @else
            @foreach ($filas as $f)
                <div class="fila-dato">
                    <div class="min-w-0"><div class="fw-semibold">{{ $f['nombre'] }}</div><div class="small text-suave">{{ $f['codigo'] }} · {{ $f['bodega'] }}</div></div>
                    <span class="cant {{ $f['cantidad_disponible'] <= 0 ? 'cero' : '' }}">{{ \App\Support\Formato::numero($f['cantidad_disponible']) }}</span>
                </div>
            @endforeach
        @endif
    </div>
@endsection
