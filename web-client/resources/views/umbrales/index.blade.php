@extends('layouts.app')

@section('titulo', 'Stock mínimo')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Stock mínimo', 'volver' => route('administrar'), 'textoVolver' => 'Administrar'])
    @error('cantidad_minima')<div class="alert alert-danger" role="alert">{{ $message }}</div>@enderror
    <p class="text-suave">Cuando el total de un producto baja del mínimo, aparece en «con poco stock» del inicio.</p>

    <section class="tarjeta">
        <h2>Cambiar el mínimo de otro producto</h2>
        <form method="get" action="{{ route('umbrales.index') }}" role="search" class="mb-2">
            <div class="d-flex gap-2">
                <input class="form-control" type="search" name="q" value="{{ $texto }}" placeholder="Nombre o código del producto" aria-label="Buscar producto">
                <button class="btn btn-outline-primary px-4">Buscar</button>
            </div>
        </form>
        @if ($falloBusqueda)
            @include('partials.no-disponible', ['texto' => 'No pudimos buscar productos.'])
        @elseif ($texto !== '' && ! count($resultados))
            <div class="nada py-2">No encontramos productos con «{{ $texto }}».</div>
        @else
            @foreach ($resultados as $r)
                @include('umbrales._formulario', ['idProducto' => $r['id_producto'], 'nombre' => $r['nombre'], 'detalle' => $r['codigo'], 'minimo' => $r['minimo']])
            @endforeach
        @endif
    </section>

    <section class="tarjeta">
        <h2>Productos con mínimo</h2>
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar los mínimos.'])
        @elseif (! count($filas))
            <div class="nada py-2">Todavía no hay mínimos definidos. Busca un producto arriba para ponerle uno.</div>
        @else
            @foreach ($filas as $f)
                @include('umbrales._formulario', ['idProducto' => $f['id_producto'], 'nombre' => $f['producto']['nombre'], 'detalle' => $f['producto']['codigo'], 'minimo' => $f['cantidad_minima']])
            @endforeach
        @endif
    </section>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
@endsection
