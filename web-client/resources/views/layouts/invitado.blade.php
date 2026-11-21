@extends('layouts.base')

@section('cuerpo')
    <main class="acceso">
        <section class="acceso-panel" aria-label="El Montañero">
            <div class="d-flex align-items-center gap-3 marca">@include('partials.marca', ['lema' => 'Distribuidora'])</div>
            <h1>Cada bulto, en su lugar.</h1>
            <p>El inventario de las dos bodegas, claro y a la mano: qué hay, qué falta y qué está por vencer.</p>
            <div class="lema" aria-hidden="true">
                <span><i class="bi bi-boxes"></i> Existencias al día, bodega por bodega</span>
                <span><i class="bi bi-hourglass-split"></i> Lotes por vencer antes de que se pierdan</span>
                <span><i class="bi bi-truck"></i> Traslados y compras con rastro</span>
            </div>
        </section>
        <div class="acceso-formulario">
            <div class="w-100" style="max-width:26rem">
                @include('partials.mensajes')
                @yield('contenido')
            </div>
        </div>
    </main>
@endsection
