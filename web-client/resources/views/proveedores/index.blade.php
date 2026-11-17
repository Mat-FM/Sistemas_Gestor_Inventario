@extends('layouts.app')

@section('titulo', 'Proveedores')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Proveedores', 'volver' => route('administrar'), 'textoVolver' => 'Administrar', 'accion' => route('proveedores.create'), 'textoAccion' => 'Nuevo'])

    <form method="get" action="{{ route('proveedores.index') }}" role="search" class="mb-3">
        <div class="buscador mb-2">
            <i class="bi bi-search"></i>
            <input class="form-control" type="search" name="q" value="{{ $texto }}" placeholder="Razón social o NIT" aria-label="Buscar proveedor">
        </div>
        <div class="d-flex gap-2">
            <select class="form-select" name="estado" aria-label="Estado">
                <option value="">Activos e inactivos</option>
                <option value="ACTIVO" @selected($estado === 'ACTIVO')>Solo activos</option>
                <option value="INACTIVO" @selected($estado === 'INACTIVO')>Solo inactivos</option>
            </select>
            <button class="btn btn-outline-primary px-4">Buscar</button>
        </div>
    </form>

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar los proveedores.'])
        @elseif (! count($proveedores))
            <div class="nada">{{ $texto !== '' ? "No encontramos proveedores con «{$texto}»." : 'Todavía no hay proveedores. Crea el primero.' }}</div>
        @else
            @foreach ($proveedores as $p)
                <a class="fila-dato text-decoration-none text-body" href="{{ route('proveedores.show', $p['id_proveedor']) }}">
                    <div class="min-w-0">
                        <div class="fw-semibold">{{ $p['razon_social'] }} @if ($p['estado'] !== 'ACTIVO')@include('partials.estado', ['activo' => false])@endif</div>
                        <div class="small text-suave">NIT {{ $p['nit'] }} · {{ $p['nombre_contacto'] }} · {{ $p['telefono'] }}</div>
                    </div>
                    <i class="bi bi-chevron-right text-suave"></i>
                </a>
            @endforeach
        @endif
    </div>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
@endsection
