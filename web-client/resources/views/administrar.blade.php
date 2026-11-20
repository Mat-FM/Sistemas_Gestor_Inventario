@extends('layouts.app')

@section('titulo', 'Más')

@section('contenido')
    <h1 class="h4 mb-3">Más</h1>
    <h2 class="h6 text-suave text-uppercase mb-2">Operación</h2>
    <div class="row g-3 mb-4">
        @foreach ($compras as $seccion)
            <div class="col-12 col-md-6">
                <a class="tarjeta d-flex align-items-center gap-3 text-decoration-none text-body mb-0" href="{{ route($seccion['ruta']) }}">
                    <i class="bi bi-{{ $seccion['icono'] }} fs-3 text-primary"></i>
                    <span class="flex-grow-1"><span class="d-block fw-semibold">{{ $seccion['etiqueta'] }}</span><span class="d-block small text-suave">{{ $seccion['detalle'] }}</span></span>
                    <i class="bi bi-chevron-right text-suave"></i>
                </a>
            </div>
        @endforeach
    </div>
    <h2 class="h6 text-suave text-uppercase mb-2">Administrar</h2>
    <div class="row g-3">
        @foreach ($secciones as $seccion)
            <div class="col-12 col-md-6">
                <a class="tarjeta d-flex align-items-center gap-3 text-decoration-none text-body mb-0" href="{{ route($seccion['ruta']) }}">
                    <i class="bi bi-{{ $seccion['icono'] }} fs-3 text-primary"></i>
                    <span class="flex-grow-1">
                        <span class="d-block fw-semibold">{{ $seccion['etiqueta'] }}</span>
                        <span class="d-block small text-suave">{{ $seccion['detalle'] }}</span>
                    </span>
                    <i class="bi bi-chevron-right text-suave"></i>
                </a>
            </div>
        @endforeach
    </div>
@endsection
