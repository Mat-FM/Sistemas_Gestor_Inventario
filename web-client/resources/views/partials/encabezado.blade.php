{{-- Título de una pantalla con su acción principal. Recibe titulo y, opcionales, volver (url), accion (url) y textoAccion. --}}
@if (! empty($volver))
    <a class="small d-inline-block mb-2" href="{{ $volver }}"><i class="bi bi-chevron-left"></i> {{ $textoVolver ?? 'Volver' }}</a>
@endif
<div class="d-flex justify-content-between align-items-center gap-2 mb-3">
    <h1 class="h4 mb-0">{{ $titulo }}</h1>
    @if (! empty($accion))
        <a class="btn btn-primary" href="{{ $accion }}"><i class="bi bi-plus-lg"></i> {{ $textoAccion ?? 'Nuevo' }}</a>
    @endif
</div>
