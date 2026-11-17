@extends('layouts.app')

@php($editando = $proveedor !== null)

@section('titulo', $editando ? 'Editar proveedor' : 'Nuevo proveedor')

@section('contenido')
    @include('partials.encabezado', ['titulo' => $editando ? 'Editar proveedor' : 'Nuevo proveedor', 'volver' => $editando ? route('proveedores.show', $proveedor['id_proveedor']) : route('proveedores.index'), 'textoVolver' => $editando ? 'Proveedor' : 'Proveedores'])

    <form method="post" action="{{ $editando ? route('proveedores.update', $proveedor['id_proveedor']) : route('proveedores.store') }}" class="tarjeta" style="max-width:36rem" novalidate>
        @csrf
        @if ($editando) @method('PUT') @endif

        @include('partials.campo', ['nombre' => 'nit', 'etiqueta' => 'NIT', 'valor' => $proveedor['nit'] ?? '', 'atributos' => 'maxlength="20" autocomplete="off"'.($editando ? ' readonly' : ''),
            'ayuda' => $editando ? 'El NIT no se puede cambiar.' : 'Es único. Ej.: 900123456-1'])
        @include('partials.campo', ['nombre' => 'razon_social', 'etiqueta' => 'Razón social', 'valor' => $proveedor['razon_social'] ?? '', 'atributos' => 'maxlength="150"'])
        @include('partials.campo', ['nombre' => 'nombre_contacto', 'etiqueta' => 'Persona de contacto', 'valor' => $proveedor['nombre_contacto'] ?? '', 'atributos' => 'maxlength="100"'])
        @include('partials.campo', ['nombre' => 'telefono', 'etiqueta' => 'Teléfono', 'tipo' => 'tel', 'valor' => $proveedor['telefono'] ?? '', 'atributos' => 'maxlength="20" inputmode="tel"'])
        @include('partials.campo', ['nombre' => 'correo', 'etiqueta' => 'Correo', 'tipo' => 'email', 'valor' => $proveedor['correo'] ?? '', 'atributos' => 'maxlength="255" inputmode="email"'])
        @include('partials.campo', ['nombre' => 'direccion', 'etiqueta' => 'Dirección', 'valor' => $proveedor['direccion'] ?? '', 'atributos' => 'maxlength="255"'])

        <button class="btn btn-primary btn-lg w-100">{{ $editando ? 'Guardar cambios' : 'Crear proveedor' }}</button>
    </form>
@endsection
