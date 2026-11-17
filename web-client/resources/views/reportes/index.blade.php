@extends('layouts.app')

@section('titulo', 'Reportes')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Reportes y auditoría'])
    <div class="row g-3">
        @foreach ([
            ['reportes.existencias', 'boxes', 'Existencias', 'Cuánto hay de cada producto en cada bodega'],
            ['reportes.valorizacion', 'cash-coin', 'Valorización', 'Cuánto vale el inventario, por producto'],
            ['reportes.rotacion', 'arrow-repeat', 'Rotación', 'Qué se mueve más y qué menos en un periodo'],
            ['reportes.kardex', 'journal-text', 'Kardex (auditoría)', 'Quién movió qué, cuándo y dónde'],
        ] as [$ruta, $icono, $titulo, $detalle])
            <div class="col-12 col-md-6">
                <a class="tarjeta d-flex align-items-center gap-3 text-decoration-none text-body mb-0" href="{{ route($ruta) }}">
                    <i class="bi bi-{{ $icono }} fs-3 text-primary"></i>
                    <span class="flex-grow-1"><span class="d-block fw-semibold">{{ $titulo }}</span><span class="d-block small text-suave">{{ $detalle }}</span></span>
                    <i class="bi bi-chevron-right text-suave"></i>
                </a>
            </div>
        @endforeach
    </div>
    <p class="small text-suave mt-3">Cada reporte se puede ver en pantalla o descargar en CSV (para Excel) y en PDF.</p>
@endsection
