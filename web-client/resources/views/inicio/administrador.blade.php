@extends('layouts.app')

@section('titulo', 'Inicio')

@section('contenido')
    <h1 class="h4 mb-3">Hola, {{ \Illuminate\Support\Str::before(app(\App\Support\Sesion::class)->nombre(), ' ') }} <span aria-hidden="true">👋</span></h1>

    @if ($falloBajo)
        <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos revisar qué productos tienen poco stock.'])</div>
    @elseif ($bajoTotal > 0)
        <section class="aviso-urgente" aria-labelledby="bajo">
            <h2 class="h5" id="bajo"><i class="bi bi-exclamation-triangle-fill text-warning"></i>
                {{ $bajoTotal }} {{ $bajoTotal === 1 ? 'producto con poco stock' : 'productos con poco stock' }}</h2>
            @foreach ($bajoUmbral as $fila)
                <div class="fila-dato" style="border-color:#f5d9ae">
                    <div>
                        <div class="fw-semibold">{{ $fila['producto']['nombre'] }}</div>
                        <div class="small text-suave">Mínimo {{ \App\Support\Formato::numero($fila['cantidad_minima']) }}</div>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        <span class="cant baja">{{ \App\Support\Formato::numero($fila['cantidad_total']) }}</span>
                        <a class="btn btn-sm btn-outline-primary" href="{{ route('movimientos.crear', ['tipo' => 'ENTRADA', 'id_producto' => $fila['id_producto']]) }}">Entra</a>
                    </div>
                </div>
            @endforeach
            @if ($bajoTotal > count($bajoUmbral))
                <p class="small text-suave mb-0 mt-2">Y {{ $bajoTotal - count($bajoUmbral) }} más. Estos son los más urgentes.</p>
            @endif
        </section>
    @else
        <div class="tarjeta d-flex gap-2 align-items-center"><i class="bi bi-check-circle-fill text-success fs-4"></i> Todos los productos están por encima de su mínimo.</div>
    @endif

    @if ($falloIndicadores)
        <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos calcular los indicadores.'])</div>
    @else
        @include('partials.indicadores', ['indicadores' => $indicadores, 'enlaceOrdenes' => true])
    @endif

    @include('partials.tareas')

    <a class="tarjeta d-flex justify-content-between align-items-center text-decoration-none text-body" href="{{ route('traslados.index') }}">
        <span><i class="bi bi-truck"></i> Traslados en camino</span>
        @if ($falloTransito)<span class="text-suave small">No disponible</span>@else<span class="cifra">{{ $enTransito }}</span>@endif
    </a>

    @include('partials.ultimos-movimientos')
@endsection
