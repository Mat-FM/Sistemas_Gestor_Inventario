@extends('layouts.app')

@section('titulo', 'Stock')

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        <div class="d-flex justify-content-between align-items-center mb-3">
            <h1 class="h4 mb-0">Stock</h1>
            @if ($puedeOperar)
                <div class="d-flex flex-wrap gap-2 justify-content-end">
                    <a class="btn btn-outline-primary btn-sm" href="{{ route('conteos.index') }}"><i class="bi bi-clipboard-check"></i> Conteos</a>
                    <a class="btn btn-outline-primary btn-sm" href="{{ route('lotes.index') }}"><i class="bi bi-hourglass-split"></i> Lotes por vencer</a>
                </div>
            @endif
        </div>
        <form method="get" action="{{ route('stock') }}" role="search" class="mb-3">
            <div class="buscador mb-2">
                <i class="bi bi-search"></i>
                <input class="form-control" type="search" name="q" value="{{ $busqueda }}" placeholder="Nombre o código del producto" aria-label="Buscar producto">
            </div>
            <div class="d-flex gap-2">
                @if ($puedeElegirBodega && count($bodegas))
                    <select class="form-select" name="bodega" aria-label="Bodega">
                        <option value="">Todas las bodegas</option>
                        @foreach ($bodegas as $id => $bodega)
                            <option value="{{ $id }}" @selected($idBodega === $id)>{{ $bodega['nombre'] }}</option>
                        @endforeach
                    </select>
                @endif
                <button class="btn btn-primary px-4">Buscar</button>
            </div>
        </form>

        @if ($error)
            <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos consultar el stock. Intenta de nuevo en un momento.'])</div>
        @elseif (! count($tarjetas))
            <div class="tarjeta nada">
                @if ($busqueda !== '') No encontramos productos que coincidan con «{{ $busqueda }}». Prueba con otra parte del nombre o con el código.
                @else Todavía no hay existencias registradas. @endif
            </div>
        @else
            <div class="rejilla">
                @foreach ($tarjetas as $tarjeta)
                    @include('stock._producto', ['tarjeta' => $tarjeta, 'puedeOperar' => $puedeOperar])
                @endforeach
            </div>
            @if ($hayMas)
                <p class="text-suave small text-center">Mostramos los primeros resultados. Escribe más del nombre para afinar.</p>
            @endif
            @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
        @endif
    @endif
@endsection
