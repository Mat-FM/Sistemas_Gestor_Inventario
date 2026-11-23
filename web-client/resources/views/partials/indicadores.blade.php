{{-- El panel de indicadores (RF14). Recibe $indicadores y, opcional, $enlaceOrdenes (solo quien puede abrir las órdenes lleva al enlace).
     Un indicador en null no se pudo calcular porque un servicio no respondió: se muestra «—», no un 0 que parecería verdad. --}}
@php
    $numero = fn (?int $n) => \App\Support\Formato::numero($n ?? 0);
    $tarjetas = [
        ['valor' => $indicadores['valor_total'], 'texto' => \App\Support\Formato::monedaEntera($indicadores['valor_total'] ?? 0), 'etiqueta' => 'Valor del inventario', 'clase' => '', 'enlace' => null],
        ['valor' => $indicadores['productos_agotados'], 'texto' => $numero($indicadores['productos_agotados']), 'etiqueta' => $indicadores['productos_agotados'] === 1 ? 'Producto agotado' : 'Productos agotados',
            'clase' => $indicadores['productos_agotados'] ? 'text-danger' : '', 'enlace' => null],
        ['valor' => $indicadores['proximos_a_vencer'], 'texto' => $numero($indicadores['proximos_a_vencer']), 'etiqueta' => $indicadores['proximos_a_vencer'] === 1 ? 'Lote por vencer' : 'Lotes por vencer',
            'clase' => $indicadores['proximos_a_vencer'] ? 'text-warning-emphasis' : '', 'enlace' => ! empty($enlaceOrdenes) ? route('lotes.index') : null],
        ['valor' => $indicadores['ordenes_pendientes'], 'texto' => $numero($indicadores['ordenes_pendientes']), 'etiqueta' => $indicadores['ordenes_pendientes'] === 1 ? 'Orden por recibir' : 'Órdenes por recibir',
            'clase' => '', 'enlace' => ! empty($enlaceOrdenes) ? route('compras.ordenes.index') : null, 'flecha' => true],
    ];
@endphp
<section class="indicadores" aria-label="Indicadores">
    @foreach ($tarjetas as $t)
        @if ($t['enlace'])<a class="indicador" href="{{ $t['enlace'] }}">@else<div class="indicador">@endif
            @if ($t['valor'] === null)
                <div class="cifra sin-dato" title="No disponible por ahora">—</div>
            @else
                <div class="cifra {{ $t['clase'] }}">{{ $t['texto'] }}</div>
            @endif
            <div class="peq">{{ $t['etiqueta'] }}@if ($t['enlace'] && ! empty($t['flecha'])) <i class="bi bi-chevron-right"></i>@endif</div>
        @if ($t['enlace'])</a>@else</div>@endif
    @endforeach
</section>
@if (! empty($indicadores['no_disponibles']))
    <p class="small text-suave mb-3"><i class="bi bi-info-circle"></i> Algunos datos no están disponibles por ahora; el resto está al día.</p>
@endif
