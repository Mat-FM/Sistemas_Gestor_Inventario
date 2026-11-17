@extends('layouts.app')

@section('titulo', 'Rotación')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Rotación', 'volver' => route('reportes.index'), 'textoVolver' => 'Reportes'])

    <form method="get" class="row g-2 mb-3">
        <div class="col-6"><label class="form-label small mb-1" for="desde">Desde</label><input class="form-control" type="date" id="desde" name="desde" value="{{ $filtros['fecha_desde'] }}"></div>
        <div class="col-6"><label class="form-label small mb-1" for="hasta">Hasta</label><input class="form-control" type="date" id="hasta" name="hasta" value="{{ $filtros['fecha_hasta'] }}"></div>
        <div class="col-6"><label class="form-label small mb-1" for="limite">Cuántos mostrar</label><input class="form-control" type="number" min="1" max="100" id="limite" name="limite" value="{{ $filtros['limite'] }}"></div>
        <div class="col-6 d-flex align-items-end"><button class="btn btn-outline-primary w-100">Ver</button></div>
    </form>
    @if ($errorDeFechas)<div class="alert alert-danger">{{ $errorDeFechas }}</div>@endif
    @include('partials.descargas', ['ruta' => 'reportes.rotacion', 'consulta' => ['desde' => $filtros['fecha_desde'], 'hasta' => $filtros['fecha_hasta'], 'limite' => $filtros['limite']]])

    @if ($fallo)
        <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos generar el reporte.'])</div>
    @else
        @foreach ([['Lo que más sale', $mayor, 'box-arrow-up'], ['Lo que menos sale', $menor, 'hourglass']] as [$titulo, $lista, $icono])
            <section class="tarjeta">
                <h2><i class="bi bi-{{ $icono }}"></i> {{ $titulo }}</h2>
                @forelse ($lista as $r)
                    <div class="fila-dato"><div class="min-w-0"><div class="fw-semibold">{{ $r['nombre'] }}</div><div class="small text-suave">{{ $r['codigo'] }}</div></div><span class="cant">{{ \App\Support\Formato::numero($r['salidas']) }} salidas</span></div>
                @empty
                    <div class="nada py-2">Sin datos en ese periodo.</div>
                @endforelse
            </section>
        @endforeach
        <p class="small text-suave">Cuenta solo las salidas registradas en el periodo; los productos sin salidas aparecen con 0.</p>
    @endif
@endsection
