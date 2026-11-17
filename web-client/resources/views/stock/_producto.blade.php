@php($p = $tarjeta['producto'])
<article class="tarjeta">
    <div class="d-flex justify-content-between align-items-start gap-2">
        <div>
            <h2 class="mb-0">{{ $p['nombre'] }}</h2>
            <div class="small text-suave">{{ $p['codigo'] }}@if (! empty($p['unidad_medida'])) · {{ \Illuminate\Support\Str::lower($p['unidad_medida']) }}@endif</div>
        </div>
        @if ($tarjeta['disponible'])
            <div class="text-end"><div class="cifra {{ $tarjeta['total'] <= 0 ? 'text-danger' : '' }}">{{ \App\Support\Formato::numero($tarjeta['total']) }}</div><div class="small text-suave">en total</div></div>
        @endif
    </div>
    <div class="mt-2">
        @if (! $tarjeta['disponible'])
            @include('partials.no-disponible', ['texto' => 'No pudimos consultar las existencias de este producto.'])
        @elseif (! count($tarjeta['filas']))
            <div class="nada py-2">Sin existencias registradas.</div>
        @else
            @foreach ($tarjeta['filas'] as $fila)
                <div class="fila-dato">
                    <span><i class="bi bi-building text-suave"></i> {{ $fila['bodega'] }}</span>
                    <span class="cant {{ $fila['cantidad'] <= 0 ? 'cero' : '' }}">{{ \App\Support\Formato::numero($fila['cantidad']) }}</span>
                </div>
            @endforeach
        @endif
    </div>
    @if ($puedeOperar)
        <div class="d-flex gap-2 mt-3">
            <a class="btn btn-outline-primary flex-fill" href="{{ route('movimientos.crear', ['tipo' => 'ENTRADA', 'id_producto' => $p['id_producto']]) }}">Entra</a>
            <a class="btn btn-outline-primary flex-fill" href="{{ route('movimientos.crear', ['tipo' => 'SALIDA', 'id_producto' => $p['id_producto']]) }}">Sale</a>
            <a class="btn btn-outline-primary flex-fill" href="{{ route('traslados.crear', ['id_producto' => $p['id_producto']]) }}">Trasladar</a>
        </div>
    @endif
</article>
