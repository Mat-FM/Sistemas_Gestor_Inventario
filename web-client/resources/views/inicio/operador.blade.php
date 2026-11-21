@extends('layouts.app')

@section('titulo', 'Inicio')

@section('contenido')
    @include('partials.saludo', ['frase' => 'Lo que toca hacer hoy en tu bodega.'])

    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        <div class="panel-inicio panel-operador">
            <div class="pi-tareas">@include('partials.tareas')</div>
            <div class="pi-aviso">
            @if ($falloTraslados)
                <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos revisar los traslados por recibir.'])</div>
            @elseif (count($porRecibir))
                <section class="aviso-info" aria-labelledby="recibir">
                    <h2 class="h5" id="recibir"><i class="bi bi-box-seam"></i> {{ count($porRecibir) }} {{ count($porRecibir) === 1 ? 'traslado por recibir' : 'traslados por recibir' }}</h2>
                    @foreach ($porRecibir as $t)
                        <div class="fila-dato" style="border-color:#c5dcf7">
                            <div>
                                <div class="fw-semibold">{{ $t['producto']['nombre'] }} × {{ \App\Support\Formato::numero($t['cantidad']) }}</div>
                                <div class="small text-suave">Desde {{ $t['bodega_origen'] }} · enviado {{ \App\Support\Formato::fecha($t['fecha_envio']) }}</div>
                            </div>
                            <form method="post" action="{{ route('traslados.recibir', $t['id_traslado']) }}">@csrf
                                <input type="hidden" name="clave" value="{{ \Illuminate\Support\Str::uuid() }}">
                                <button class="btn btn-primary btn-sm">Recibir</button>
                            </form>
                        </div>
                    @endforeach
                </section>
            @else
                <div class="tarjeta d-flex gap-2 align-items-center"><i class="bi bi-check-circle-fill text-success fs-4"></i> No tienes traslados por recibir.</div>
            @endif
            </div>
            <div class="pi-indicadores">
            @if ($falloOrdenes)
                <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos revisar las órdenes de compra.'])</div>
            @elseif (count($ordenesPorRecibir))
                <section class="aviso-info" aria-labelledby="ordenes">
                    <h2 class="h5" id="ordenes"><i class="bi bi-cart3"></i> {{ count($ordenesPorRecibir) }} {{ count($ordenesPorRecibir) === 1 ? 'orden de compra por recibir' : 'órdenes de compra por recibir' }}</h2>
                    @foreach ($ordenesPorRecibir as $o)
                        <a class="fila-dato text-decoration-none text-body" style="border-color:#c5dcf7" href="{{ route('compras.ordenes.show', $o['id_orden']) }}">
                            <div><div class="fw-semibold">{{ $o['numero'] }} · {{ $o['proveedor'] }}</div><div class="small text-suave">Se espera el {{ \App\Support\Formato::dia($o['fecha_esperada']) }}</div></div>
                            <i class="bi bi-chevron-right text-suave"></i>
                        </a>
                    @endforeach
                </section>
            @endif
            </div>
            <div class="pi-movimientos">@include('partials.ultimos-movimientos')</div>
        </div>
    @endif
@endsection
