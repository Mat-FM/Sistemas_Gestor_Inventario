@extends('layouts.app')

@section('titulo', $proveedor['razon_social'])

@section('contenido')
    @include('partials.encabezado', ['titulo' => $proveedor['razon_social'], 'volver' => route('proveedores.index'), 'textoVolver' => 'Proveedores'])

    <section class="tarjeta">
        <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
            <div>@include('partials.estado', ['activo' => $proveedor['estado'] === 'ACTIVO'])</div>
            <div class="d-flex gap-2">
                <a class="btn btn-sm btn-outline-primary" href="{{ route('proveedores.edit', $proveedor['id_proveedor']) }}">Editar</a>
                <form method="post" action="{{ route($proveedor['estado'] === 'ACTIVO' ? 'proveedores.inactivar' : 'proveedores.activar', $proveedor['id_proveedor']) }}"
                      @if ($proveedor['estado'] === 'ACTIVO') data-confirmar="¿Inactivar a «{{ $proveedor['razon_social'] }}»?" @endif>@csrf
                    <button class="btn btn-sm btn-outline-secondary">{{ $proveedor['estado'] === 'ACTIVO' ? 'Inactivar' : 'Activar' }}</button>
                </form>
            </div>
        </div>
        @foreach (['NIT' => $proveedor['nit'], 'Contacto' => $proveedor['nombre_contacto'], 'Teléfono' => $proveedor['telefono'], 'Correo' => $proveedor['correo'], 'Dirección' => $proveedor['direccion']] as $etiqueta => $dato)
            <div class="fila-dato"><span class="text-suave">{{ $etiqueta }}</span><span class="text-end">{{ $dato }}</span></div>
        @endforeach
    </section>

    <section class="tarjeta">
        <h2>Productos que suministra</h2>
        @if ($falloAsociados)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar sus productos.'])
        @elseif (! count($asociados))
            <div class="nada py-2">Todavía no tiene productos asociados.</div>
        @else
            @foreach ($asociados as $a)
                <div class="fila-dato">
                    <div><div class="fw-semibold">{{ $a['producto']['nombre'] }}</div><div class="small text-suave">{{ $a['producto']['codigo'] }}</div></div>
                    <form method="post" action="{{ route('proveedores.quitar', [$proveedor['id_proveedor'], $a['id_producto']]) }}" data-confirmar="¿Quitar «{{ $a['producto']['nombre'] }}» de este proveedor?">@csrf @method('DELETE')
                        <button class="btn btn-sm btn-outline-danger" aria-label="Quitar {{ $a['producto']['nombre'] }}"><i class="bi bi-x-lg"></i></button>
                    </form>
                </div>
            @endforeach
        @endif
    </section>

    <section class="tarjeta">
        <h2>Asociar otro producto</h2>
        <form method="get" action="{{ route('proveedores.show', $proveedor['id_proveedor']) }}" role="search" class="mb-2">
            <div class="d-flex gap-2">
                <input class="form-control" type="search" name="q" value="{{ $texto }}" placeholder="Nombre o código del producto" aria-label="Buscar producto">
                <button class="btn btn-outline-primary px-4">Buscar</button>
            </div>
        </form>
        @if ($falloBusqueda)
            @include('partials.no-disponible', ['texto' => 'No pudimos buscar productos.'])
        @elseif ($texto !== '' && ! count($resultados))
            <div class="nada py-2">No hay productos nuevos con «{{ $texto }}» para asociar.</div>
        @else
            @foreach ($resultados as $r)
                <div class="fila-dato">
                    <div><div class="fw-semibold">{{ $r['nombre'] }}</div><div class="small text-suave">{{ $r['codigo'] }}</div></div>
                    <form method="post" action="{{ route('proveedores.asociar', $proveedor['id_proveedor']) }}">@csrf
                        <input type="hidden" name="id_producto" value="{{ $r['id_producto'] }}">
                        <button class="btn btn-sm btn-primary">Asociar</button>
                    </form>
                </div>
            @endforeach
        @endif
    </section>
@endsection
