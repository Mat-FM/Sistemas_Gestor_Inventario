@extends('layouts.app')

@section('titulo', 'Inicio')

@section('contenido')
    @include('partials.saludo', ['frase' => 'Así está el inventario de las dos bodegas hoy.'])

    {{-- En celular los bloques van uno tras otro; desde 1200 px se reparten en dos columnas (ver .panel-inicio en app.css). --}}
    <div class="panel-inicio">
        <div class="pi-aviso">
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
        </div>

        <div class="pi-indicadores">
            @if ($falloIndicadores)
                <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos calcular los indicadores.'])</div>
            @else
                @include('partials.indicadores', ['indicadores' => $indicadores, 'enlaceOrdenes' => true])
            @endif
        </div>

        <div class="pi-tareas">@include('partials.tareas')</div>

        <a class="tarjeta pi-transito d-flex justify-content-between align-items-center text-decoration-none text-body" href="{{ route('traslados.index') }}">
            <span><i class="bi bi-truck"></i> Traslados en camino</span>
            @if ($falloTransito)<span class="text-suave small">No disponible</span>@else<span class="cifra">{{ $enTransito }}</span>@endif
        </a>

        <div class="pi-movimientos">@include('partials.ultimos-movimientos')</div>
    </div>
@endsection
