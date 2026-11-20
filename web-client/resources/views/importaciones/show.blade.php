@extends('layouts.app')

@section('titulo', 'Importación #'.$importacion['id_importacion'])

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Importación #'.$importacion['id_importacion'], 'volver' => route('importaciones.index'), 'textoVolver' => 'Importar datos'])

    <div class="tarjeta">
        <div class="d-flex justify-content-between align-items-start gap-2">
            <div>
                <div class="fw-semibold">{{ $tipo }}</div>
                <div class="small text-suave">{{ $importacion['nombre_archivo'] }}</div>
                <div class="small text-suave">{{ \App\Support\Formato::fecha($importacion['fecha']) }}</div>
            </div>
            @include('importaciones._estado', ['estado' => $importacion['estado']])
        </div>
        <div class="row text-center mt-3 g-2">
            <div class="col-4"><div class="fs-4 fw-semibold">{{ $importacion['filas_totales'] }}</div><div class="small text-suave">Filas</div></div>
            <div class="col-4"><div class="fs-4 fw-semibold text-success">{{ $importacion['filas_validas'] }}</div><div class="small text-suave">Creadas</div></div>
            <div class="col-4"><div class="fs-4 fw-semibold {{ $importacion['filas_con_error'] > 0 ? 'text-danger' : '' }}">{{ $importacion['filas_con_error'] }}</div><div class="small text-suave">Con error</div></div>
        </div>
        @if ($importacion['estado'] === 'FALLIDA')
            <div class="alert alert-danger mt-3 mb-0" role="alert">Un servicio no respondió y la importación no se completó. Solo se crearon las filas de los bloques que alcanzaron a confirmarse.</div>
        @endif
    </div>

    @if (count($errores))
        <div class="tarjeta">
            <h2>Qué corregir</h2>
            @foreach ($errores as $e)
                <div class="fila-dato">
                    <div>
                        <div class="fw-semibold">{{ $e['numero_fila'] === 0 ? 'Todo el archivo' : 'Fila '.$e['numero_fila'] }}@if ($e['campo']) · <span class="text-suave">{{ $e['campo'] }}</span>@endif</div>
                        <div class="small">{{ $e['mensaje'] }}</div>
                    </div>
                </div>
            @endforeach
            @if ($erroresOcultos > 0)
                <div class="small text-suave pt-2">Y {{ $erroresOcultos }} {{ $erroresOcultos === 1 ? 'error más' : 'errores más' }}. Corrige estos primero y vuelve a subir el archivo.</div>
            @endif
        </div>
    @endif
@endsection
