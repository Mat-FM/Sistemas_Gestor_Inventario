@extends('layouts.app')

@section('titulo', 'Nueva orden de compra')

@php($filasIniciales = collect(old('lineas', [['id_producto' => '', 'cantidad' => '', 'precio' => '']]))->values()->all())

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Nueva orden de compra', 'volver' => route('compras.ordenes.index'), 'textoVolver' => 'Compras'])

    <form method="post" action="{{ route('compras.ordenes.store') }}" class="tarjeta" style="max-width:44rem" novalidate>
        @csrf
        @include('partials.campo', ['nombre' => 'id_proveedor', 'etiqueta' => 'Proveedor', 'tipo' => 'select', 'opciones' => $proveedores, 'vacio' => 'Elige el proveedor'])
        @include('partials.campo', ['nombre' => 'id_bodega_destino', 'etiqueta' => 'Llega a la bodega', 'tipo' => 'select', 'opciones' => $bodegas, 'vacio' => 'Elige la bodega'])
        @include('partials.campo', ['nombre' => 'fecha_esperada', 'etiqueta' => 'Fecha esperada', 'tipo' => 'date', 'valor' => '', 'atributos' => 'min="'.now(config('interfaz.zona_horaria'))->toDateString().'"'])

        <h2 class="mt-4">Productos</h2>
        @error('lineas')<div class="alert alert-danger py-2">{{ $message }}</div>@enderror
        @foreach (collect($errors->get('lineas.*'))->flatten()->unique() as $mensaje)<div class="alert alert-danger py-2">{{ $mensaje }}</div>@endforeach

        <div id="lineas" data-siguiente="{{ count($filasIniciales) }}">
            @foreach ($filasIniciales as $i => $valores)
                @include('compras.ordenes._linea', ['i' => $i, 'valores' => $valores, 'productos' => $productos])
            @endforeach
        </div>
        <template id="plantilla-linea">@include('compras.ordenes._linea', ['i' => '__I__', 'valores' => [], 'productos' => $productos])</template>

        <button type="button" class="btn btn-outline-primary w-100 mb-3" data-agregar-linea="#lineas" data-plantilla="#plantilla-linea"><i class="bi bi-plus-lg"></i> Agregar otro producto</button>
        <button class="btn btn-primary btn-lg w-100">Crear orden</button>
        <p class="small text-suave text-center mt-2 mb-0">La orden queda «Creada». Cuando la envíes al proveedor, podrás registrar lo que llegue.</p>
    </form>
@endsection
