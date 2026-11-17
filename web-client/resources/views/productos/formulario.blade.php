@extends('layouts.app')

@php($editando = $producto !== null)

@section('titulo', $editando ? 'Editar producto' : 'Nuevo producto')

@section('contenido')
    @include('partials.encabezado', ['titulo' => $editando ? 'Editar producto' : 'Nuevo producto', 'volver' => route('productos.index'), 'textoVolver' => 'Productos'])

    <form method="post" action="{{ $editando ? route('productos.update', $producto['id_producto']) : route('productos.store') }}" class="tarjeta" style="max-width:36rem" novalidate>
        @csrf
        @if ($editando) @method('PUT') @endif

        @include('partials.campo', ['nombre' => 'codigo', 'etiqueta' => 'Código', 'valor' => $producto['codigo'] ?? '',
            'atributos' => 'maxlength="30" autocomplete="off"'.($editando ? ' readonly' : ''),
            'ayuda' => $editando ? 'El código no se puede cambiar.' : 'Es único: no puede haber dos productos con el mismo código. Ej.: CAF-500'])
        @include('partials.campo', ['nombre' => 'nombre', 'etiqueta' => 'Nombre', 'valor' => $producto['nombre'] ?? '', 'atributos' => 'maxlength="150"'])
        @include('partials.campo', ['nombre' => 'id_categoria', 'etiqueta' => 'Categoría', 'tipo' => 'select', 'valor' => $producto['id_categoria'] ?? '', 'opciones' => $categorias, 'vacio' => 'Elige la categoría'])
        @include('partials.campo', ['nombre' => 'unidad_medida', 'etiqueta' => 'Unidad de medida', 'valor' => $producto['unidad_medida'] ?? '',
            'atributos' => 'maxlength="20" list="unidades" autocomplete="off"', 'ayuda' => 'Elige una de la lista o escribe otra. Ej.: UNIDAD, KG, LITRO'])
        <datalist id="unidades"><option value="UNIDAD"><option value="KG"><option value="GRAMO"><option value="LITRO"><option value="CAJA"><option value="PAQUETE"></datalist>
        @include('partials.campo', ['nombre' => 'precio', 'etiqueta' => 'Precio de lista', 'valor' => isset($producto['precio']) ? rtrim(rtrim(number_format((float) $producto['precio'], 2, ',', ''), '0'), ',') : '',
            'atributos' => 'inputmode="decimal" autocomplete="off"', 'ayuda' => 'En pesos. Ej.: 18.500 o 18500,50'])
        @include('partials.campo', ['nombre' => 'descripcion', 'etiqueta' => 'Descripción', 'tipo' => 'textarea', 'valor' => $producto['descripcion'] ?? '', 'opcional' => true, 'atributos' => 'maxlength="500"'])

        <button class="btn btn-primary btn-lg w-100">{{ $editando ? 'Guardar cambios' : 'Crear producto' }}</button>
    </form>
@endsection
