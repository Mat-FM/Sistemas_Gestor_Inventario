@extends('layouts.app')

@section('titulo', 'Bodegas')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Bodegas', 'volver' => route('administrar'), 'textoVolver' => 'Administrar', 'accion' => route('bodegas.create'), 'textoAccion' => 'Nueva'])

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar las bodegas.'])
        @elseif (! count($bodegas))
            <div class="nada">Todavía no hay bodegas. Crea la primera.</div>
        @else
            @foreach ($bodegas as $b)
                <div class="fila-dato fila-acciones align-items-start">
                    <div class="min-w-0">
                        <div class="fw-semibold">{{ $b['nombre'] }} @if (! $b['activa'])@include('partials.estado', ['activo' => false])@endif</div>
                        <div class="small text-suave">{{ $b['codigo'] }} · {{ $b['ciudad'] }} · {{ $b['direccion'] }}</div>
                    </div>
                    <div class="acciones d-flex gap-2">
                        <a class="btn btn-sm btn-outline-primary" href="{{ route('bodegas.edit', $b['id_bodega']) }}">Editar</a>
                        <form method="post" action="{{ route($b['activa'] ? 'bodegas.inactivar' : 'bodegas.activar', $b['id_bodega']) }}"
                              @if ($b['activa']) data-confirmar="¿Inactivar la bodega «{{ $b['nombre'] }}»? Dejará de recibir movimientos." @endif>@csrf
                            <button class="btn btn-sm btn-outline-secondary">{{ $b['activa'] ? 'Inactivar' : 'Activar' }}</button>
                        </form>
                    </div>
                </div>
            @endforeach
        @endif
    </div>
@endsection
