@extends('layouts.app')

@section('titulo', 'Editar categoría')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Editar categoría', 'volver' => route('categorias.index'), 'textoVolver' => 'Categorías'])

    <form method="post" action="{{ route('categorias.update', $categoria['id_categoria']) }}" class="tarjeta" style="max-width:36rem" novalidate>
        @csrf @method('PUT')
        @include('partials.campo', ['nombre' => 'nombre', 'etiqueta' => 'Nombre', 'valor' => $categoria['nombre'], 'atributos' => 'maxlength="100"'])
        @include('partials.campo', ['nombre' => 'descripcion', 'etiqueta' => 'Descripción', 'valor' => $categoria['descripcion'] ?? '', 'opcional' => true, 'atributos' => 'maxlength="255"'])
        @if ($tieneHijas)
            <p class="small text-suave">Esta categoría tiene subcategorías, así que no puede quedar dentro de otra (las categorías son de dos niveles).</p>
        @else
            @include('partials.campo', ['nombre' => 'id_categoria_padre', 'etiqueta' => 'Dentro de', 'tipo' => 'select', 'valor' => $categoria['id_categoria_padre'] ?? '', 'opcional' => true,
                'vacio' => 'Ninguna (categoría principal)', 'opciones' => $padres])
        @endif
        <button class="btn btn-primary btn-lg w-100">Guardar cambios</button>
    </form>
@endsection
