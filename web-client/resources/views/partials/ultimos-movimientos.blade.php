<div class="tarjeta">
    <div class="d-flex justify-content-between align-items-center mb-2">
        <h2 class="mb-0">Últimos movimientos</h2>
        @if (in_array(app(\App\Support\Sesion::class)->rol(), [\App\Support\Roles::ADMINISTRADOR, \App\Support\Roles::OPERADOR, \App\Support\Roles::CONTADOR], true))
            <a class="small" href="{{ route('movimientos.index') }}">Ver todos</a>
        @endif
    </div>
    @if ($falloUltimos)
        @include('partials.no-disponible', ['texto' => 'No pudimos cargar los movimientos.'])
    @elseif (! count($ultimos))
        <div class="nada">Todavía no hay movimientos.</div>
    @else
        @foreach ($ultimos as $m)
            @php $signo = \App\Support\Formato::signo($m['tipo']) ?: ($m['cantidad'] <=> 0); @endphp
            <div class="fila-dato">
                <div>
                    <div class="fw-semibold">{{ $m['producto']['nombre'] }}</div>
                    <div class="small text-suave">{{ \App\Support\Formato::tipo($m['tipo']) }} · {{ $m['bodega'] ?? '' }} · {{ \App\Support\Formato::fecha($m['fecha']) }}</div>
                </div>
                <span class="cant {{ $signo > 0 ? 'suma' : ($signo < 0 ? 'resta' : '') }}">{{ $signo > 0 ? '+' : ($signo < 0 ? '−' : '') }}{{ \App\Support\Formato::numero(abs($m['cantidad'])) }}</span>
            </div>
        @endforeach
    @endif
</div>
