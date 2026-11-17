@extends('layouts.app')

@section('titulo', 'Importar datos')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Importar datos', 'volver' => route('administrar'), 'textoVolver' => 'Más'])

    <form method="post" action="{{ route('importaciones.guardar') }}" enctype="multipart/form-data" class="tarjeta" novalidate>
        @csrf
        <h2>Subir un archivo</h2>
        @include('partials.campo', ['nombre' => 'tipo', 'etiqueta' => 'Qué vas a importar', 'tipo' => 'select',
            'opciones' => array_map(static fn (array $i) => $i['nombre'], $importables), 'vacio' => 'Elige una opción'])
        <div class="mb-3">
            <label class="form-label" for="archivo">Archivo (CSV o Excel .xlsx, hasta 2 MB)</label>
            <input class="form-control @error('archivo') is-invalid @enderror" type="file" id="archivo" name="archivo" accept=".csv,.txt,.xlsx">
            @error('archivo')<div class="invalid-feedback">{{ $message }}</div>@enderror
            <div class="form-text">La primera fila debe traer los nombres de las columnas. Las filas con errores no se crean y se te dice cuáles son.</div>
        </div>
        <button class="btn btn-primary w-100">Importar</button>
    </form>

    <section class="tarjeta">
        <h2>Plantillas</h2>
        <p class="small text-suave">Un archivo vacío con las columnas exactas que pide cada tipo.</p>
        @foreach ($importables as $codigo => $i)
            <div class="fila-dato">
                <div>
                    <div class="fw-semibold">{{ $i['nombre'] }}</div>
                    <div class="small text-suave">{{ implode(', ', $i['columnas']) }}</div>
                </div>
                <a class="btn btn-outline-primary btn-sm" href="{{ route('importaciones.plantilla', $codigo) }}"><i class="bi bi-download"></i> Plantilla</a>
            </div>
        @endforeach
    </section>

    <section class="tarjeta">
        <h2>Importaciones anteriores</h2>
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar el historial.'])
        @elseif (! count($filas))
            <div class="nada py-2">Todavía no se ha importado nada.</div>
        @else
            @foreach ($filas as $f)
                <a class="fila-dato text-decoration-none text-body" href="{{ route('importaciones.show', $f['id_importacion']) }}">
                    <div>
                        <div class="fw-semibold">{{ $importables[$f['tipo']]['nombre'] ?? $f['tipo'] }} · {{ $f['nombre_archivo'] }}</div>
                        <div class="small text-suave">{{ \App\Support\Formato::fecha($f['fecha']) }} · {{ $f['filas_validas'] }} de {{ $f['filas_totales'] }} {{ $f['filas_totales'] === 1 ? 'fila creada' : 'filas creadas' }}</div>
                    </div>
                    <div class="text-end">
                        @include('importaciones._estado', ['estado' => $f['estado']])
                        <i class="bi bi-chevron-right text-suave ms-1"></i>
                    </div>
                </a>
            @endforeach
        @endif
    </section>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
@endsection
