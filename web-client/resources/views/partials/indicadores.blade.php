{{-- El panel de indicadores (RF14). Recibe $indicadores y, opcional, $enlaceOrdenes (solo quien puede abrir las órdenes). --}}
<section class="indicadores" aria-label="Indicadores">
    <div class="indicador"><div class="cifra">{{ \App\Support\Formato::monedaEntera($indicadores['valor_total']) }}</div><div class="peq">Valor del inventario</div></div>
    <div class="indicador"><div class="cifra {{ $indicadores['productos_agotados'] ? 'text-danger' : '' }}">{{ \App\Support\Formato::numero($indicadores['productos_agotados']) }}</div><div class="peq">{{ $indicadores['productos_agotados'] === 1 ? 'Producto agotado' : 'Productos agotados' }}</div></div>
    @php($tarjetaVencer = '<div class="cifra '.($indicadores['proximos_a_vencer'] ? 'text-warning-emphasis' : '').'">'.\App\Support\Formato::numero($indicadores['proximos_a_vencer']).'</div><div class="peq">'.($indicadores['proximos_a_vencer'] === 1 ? 'Lote por vencer' : 'Lotes por vencer').'</div>')
    @if (! empty($enlaceOrdenes))
        <a class="indicador" href="{{ route('lotes.index') }}">{!! $tarjetaVencer !!}</a>
    @else
        <div class="indicador">{!! $tarjetaVencer !!}</div>
    @endif
    @if (! empty($enlaceOrdenes))
        <a class="indicador" href="{{ route('compras.ordenes.index') }}"><div class="cifra">{{ \App\Support\Formato::numero($indicadores['ordenes_pendientes']) }}</div><div class="peq">{{ $indicadores['ordenes_pendientes'] === 1 ? 'Orden por recibir' : 'Órdenes por recibir' }} <i class="bi bi-chevron-right"></i></div></a>
    @else
        <div class="indicador"><div class="cifra">{{ \App\Support\Formato::numero($indicadores['ordenes_pendientes']) }}</div><div class="peq">{{ $indicadores['ordenes_pendientes'] === 1 ? 'Orden por recibir' : 'Órdenes por recibir' }}</div></div>
    @endif
</section>
