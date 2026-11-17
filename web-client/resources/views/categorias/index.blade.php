@extends('layouts.app')

@section('titulo', 'Categorías')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Categorías', 'volver' => route('administrar'), 'textoVolver' => 'Administrar'])

    <form method="post" action="{{ route('categorias.store') }}" class="tarjeta" novalidate>
        @csrf
        <h2>Nueva categoría</h2>
        <div class="row g-2">
            <div class="col-12 col-md-5">
                @include('partials.campo', ['nombre' => 'nombre', 'etiqueta' => 'Nombre', 'atributos' => 'maxlength="100"'])
            </div>
            <div class="col-12 col-md-4">
                @include('partials.campo', ['nombre' => 'id_categoria_padre', 'etiqueta' => 'Dentro de', 'tipo' => 'select', 'opcional' => true, 'vacio' => 'Ninguna (categoría principal)',
                    'opciones' => collect($arbol)->pluck('nombre', 'id_categoria')->all()])
            </div>
            <div class="col-12 col-md-3 d-flex align-items-end"><button class="btn btn-primary w-100 mb-3">Crear</button></div>
        </div>
    </form>

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar las categorías.'])
        @elseif (! count($arbol))
            <div class="nada">Todavía no hay categorías. Crea la primera arriba.</div>
        @else
            @foreach ($arbol as $categoria)
                @include('categorias._fila', ['categoria' => $categoria, 'sub' => false])
                @foreach ($categoria['subcategorias'] ?? [] as $hija)
                    @include('categorias._fila', ['categoria' => $hija, 'sub' => true])
                @endforeach
            @endforeach
        @endif
    </div>
@endsection
