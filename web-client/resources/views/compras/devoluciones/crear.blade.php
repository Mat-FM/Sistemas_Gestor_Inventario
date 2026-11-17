@extends('layouts.app')

@section('titulo', 'Devolver a un proveedor')

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        @include('partials.encabezado', ['titulo' => 'Devolver a un proveedor', 'volver' => route('compras.devoluciones.index'), 'textoVolver' => 'Devoluciones'])

        <form method="post" action="{{ route('compras.devoluciones.store') }}" class="tarjeta" style="max-width:36rem" novalidate>
            @csrf
            <input type="hidden" name="clave" value="{{ old('clave') ?: (string) \Illuminate\Support\Str::uuid() }}">
            @include('partials.campo', ['nombre' => 'id_proveedor', 'etiqueta' => 'Proveedor', 'tipo' => 'select', 'opciones' => $proveedores, 'vacio' => 'Elige el proveedor'])
            @include('partials.campo', ['nombre' => 'id_producto', 'etiqueta' => 'Producto', 'tipo' => 'select', 'opciones' => $productos, 'vacio' => 'Elige el producto'])
            @if ($bodegaFija)
                <input type="hidden" name="id_bodega" value="{{ $bodegaFija }}">
                <div class="mb-3"><label class="form-label">Sale de la bodega</label><input class="form-control" value="{{ $bodegas[$bodegaFija] ?? 'Tu bodega' }}" disabled></div>
            @else
                @include('partials.campo', ['nombre' => 'id_bodega', 'etiqueta' => 'Sale de la bodega', 'tipo' => 'select', 'opciones' => $bodegas, 'vacio' => 'Elige la bodega'])
            @endif
            @include('partials.campo', ['nombre' => 'cantidad', 'etiqueta' => '¿Cuántas unidades se devuelven?', 'atributos' => 'inputmode="numeric" autocomplete="off" placeholder="0"'])
            @include('partials.campo', ['nombre' => 'motivo', 'etiqueta' => 'Motivo', 'tipo' => 'textarea', 'atributos' => 'maxlength="255"', 'ayuda' => 'Por ejemplo: empaque roto, producto vencido, pedido equivocado.'])
            <button class="btn btn-primary btn-lg w-100">Registrar devolución</button>
            <p class="small text-suave text-center mt-2 mb-0">La mercancía sale del inventario de la bodega en este momento.</p>
        </form>
    @endif
@endsection
