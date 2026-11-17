@extends('layouts.app')

@php($editando = $bodega !== null)

@section('titulo', $editando ? 'Editar bodega' : 'Nueva bodega')

@section('contenido')
    @include('partials.encabezado', ['titulo' => $editando ? 'Editar bodega' : 'Nueva bodega', 'volver' => route('bodegas.index'), 'textoVolver' => 'Bodegas'])

    <form method="post" action="{{ $editando ? route('bodegas.update', $bodega['id_bodega']) : route('bodegas.store') }}" class="tarjeta" style="max-width:36rem" novalidate>
        @csrf
        @if ($editando) @method('PUT') @endif

        @include('partials.campo', ['nombre' => 'codigo', 'etiqueta' => 'Código', 'valor' => $bodega['codigo'] ?? '', 'atributos' => 'maxlength="30" autocomplete="off"'.($editando ? ' readonly' : ''),
            'ayuda' => $editando ? 'El código no se puede cambiar.' : 'Corto y único; no distingue mayúsculas. Ej.: B3'])
        @include('partials.campo', ['nombre' => 'nombre', 'etiqueta' => 'Nombre', 'valor' => $bodega['nombre'] ?? '', 'atributos' => 'maxlength="100"'])
        @include('partials.campo', ['nombre' => 'ciudad', 'etiqueta' => 'Ciudad', 'valor' => $bodega['ciudad'] ?? '', 'atributos' => 'maxlength="100"'])
        @include('partials.campo', ['nombre' => 'direccion', 'etiqueta' => 'Dirección', 'valor' => $bodega['direccion'] ?? '', 'atributos' => 'maxlength="255"'])

        <button class="btn btn-primary btn-lg w-100">{{ $editando ? 'Guardar cambios' : 'Crear bodega' }}</button>
    </form>
@endsection
