@extends('layouts.app')

@section('titulo', 'Traslados')

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        <div class="d-flex justify-content-between align-items-center mb-3">
            <h1 class="h4 mb-0">Traslados</h1>
            <a class="btn btn-primary" href="{{ route('traslados.crear') }}"><i class="bi bi-plus-lg"></i> Nuevo</a>
        </div>

        <ul class="nav nav-pills pestanas mb-3">
            @foreach (['EN_TRANSITO' => 'Por recibir', 'RECIBIDO' => 'Recibidos', 'todos' => 'Todos'] as $codigo => $nombre)
                <li class="nav-item"><a class="nav-link {{ $estado === $codigo ? 'active' : '' }}" style="{{ $estado === $codigo ? 'background:#0f766e' : '' }}"
                    href="{{ route('traslados.index', ['estado' => $codigo]) }}">{{ $nombre }}</a></li>
            @endforeach
        </ul>

        <div class="tarjeta">
            @if ($fallo)
                @include('partials.no-disponible', ['texto' => 'No pudimos cargar los traslados.'])
            @elseif (! count($filas))
                <div class="nada">{{ $estado === 'EN_TRANSITO' ? 'No hay traslados por recibir.' : 'No hay traslados para mostrar.' }}</div>
            @else
                @foreach ($filas as $t)
                    <div class="fila-dato">
                        <div>
                            <div class="fw-semibold">{{ $t['producto']['nombre'] }} × {{ \App\Support\Formato::numero($t['cantidad']) }}</div>
                            <div class="small text-suave">{{ $t['bodega_origen'] }} <i class="bi bi-arrow-right"></i> {{ $t['bodega_destino'] }}</div>
                            <div class="small text-suave">Enviado {{ \App\Support\Formato::fecha($t['fecha_envio']) }}@if ($t['fecha_recepcion']) · recibido {{ \App\Support\Formato::fecha($t['fecha_recepcion']) }}@endif</div>
                        </div>
                        <div class="text-end">
                            @if ($t['puedeRecibir'])
                                <form method="post" action="{{ route('traslados.recibir', $t['id_traslado']) }}">@csrf
                                    <input type="hidden" name="clave" value="{{ $t['clave'] }}">
                                    <button class="btn btn-primary btn-sm">Recibir</button>
                                </form>
                            @else
                                <span class="etiqueta {{ $t['estado'] === 'RECIBIDO' ? 'ok' : 'info' }}">{{ $t['estado'] === 'RECIBIDO' ? 'Recibido' : 'En camino' }}</span>
                            @endif
                        </div>
                    </div>
                @endforeach
            @endif
        </div>
        @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
    @endif
@endsection
