@extends('layouts.app')

@section('titulo', 'Productos')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Productos', 'volver' => route('administrar'), 'textoVolver' => 'Administrar', 'accion' => route('productos.create'), 'textoAccion' => 'Nuevo'])

    <form method="get" action="{{ route('productos.index') }}" role="search" class="mb-3">
        <div class="buscador mb-2">
            <i class="bi bi-search"></i>
            <input class="form-control" type="search" name="q" value="{{ $texto }}" placeholder="Nombre o código" aria-label="Buscar producto">
        </div>
        <div class="d-flex flex-wrap gap-2">
            <select class="form-select flex-fill" style="min-width:9rem" name="categoria" aria-label="Categoría">
                <option value="">Todas las categorías</option>
                @foreach ($categorias as $id => $c)<option value="{{ $id }}" @selected($categoria === $id)>{{ $c['nombre'] }}</option>@endforeach
            </select>
            <select class="form-select flex-fill" style="min-width:9rem" name="estado" aria-label="Estado">
                <option value="">Activos e inactivos</option>
                <option value="ACTIVO" @selected($estado === 'ACTIVO')>Solo activos</option>
                <option value="INACTIVO" @selected($estado === 'INACTIVO')>Solo inactivos</option>
            </select>
            <button class="btn btn-outline-primary px-4">Buscar</button>
        </div>
    </form>

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar los productos.'])
        @elseif (! count($productos))
            <div class="nada">{{ $texto !== '' ? "No encontramos productos con «{$texto}»." : 'Todavía no hay productos. Crea el primero.' }}</div>
        @else
            @foreach ($productos as $p)
                <div class="fila-dato fila-acciones align-items-start">
                    <div class="min-w-0">
                        <div class="fw-semibold">{{ $p['nombre'] }} @if ($p['estado'] !== 'ACTIVO')@include('partials.estado', ['activo' => false])@endif</div>
                        <div class="small text-suave">{{ $p['codigo'] }} · {{ $categorias[$p['id_categoria']]['nombre'] ?? 'Sin categoría' }} · {{ \App\Support\Formato::moneda($p['precio']) }} por {{ \Illuminate\Support\Str::lower($p['unidad_medida']) }}</div>
                    </div>
                    <div class="acciones d-flex gap-2">
                        <a class="btn btn-sm btn-outline-primary" href="{{ route('productos.edit', $p['id_producto']) }}">Editar</a>
                        <form method="post" action="{{ route($p['estado'] === 'ACTIVO' ? 'productos.inactivar' : 'productos.activar', $p['id_producto']) }}"
                              @if ($p['estado'] === 'ACTIVO') data-confirmar="¿Dar de baja «{{ $p['nombre'] }}»? Ya no se podrá usar en movimientos nuevos; su historial se conserva." @endif>@csrf
                            <button class="btn btn-sm btn-outline-secondary">{{ $p['estado'] === 'ACTIVO' ? 'Inactivar' : 'Activar' }}</button>
                        </form>
                    </div>
                </div>
            @endforeach
        @endif
    </div>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @elseif (count($productos) >= 50)<p class="small text-suave text-center">Mostramos los primeros 50. Escribe más para afinar.</p>@endif
@endsection
