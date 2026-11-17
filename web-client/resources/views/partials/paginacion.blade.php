@php
    $pagina = (int) ($meta['pagina'] ?? 1);
    $ultima = (int) max(1, ceil(((int) ($meta['total'] ?? 0)) / max(1, (int) ($meta['por_pagina'] ?? 20))));
@endphp
@if ($ultima > 1)
    <nav class="d-flex justify-content-between align-items-center my-3" aria-label="Páginas">
        <a class="btn btn-outline-primary {{ $pagina <= 1 ? 'disabled' : '' }}" href="{{ request()->fullUrlWithQuery(['pagina' => $pagina - 1]) }}"><i class="bi bi-chevron-left"></i> Anterior</a>
        <span class="text-suave small">Página {{ $pagina }} de {{ $ultima }}</span>
        <a class="btn btn-outline-primary {{ $pagina >= $ultima ? 'disabled' : '' }}" href="{{ request()->fullUrlWithQuery(['pagina' => $pagina + 1]) }}">Siguiente <i class="bi bi-chevron-right"></i></a>
    </nav>
@endif
