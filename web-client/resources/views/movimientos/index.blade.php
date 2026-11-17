@extends('layouts.app')

@section('titulo', 'Movimientos')

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        <div class="d-flex justify-content-between align-items-center mb-3">
            <h1 class="h4 mb-0">Movimientos</h1>
            @if ($puedeRegistrar)
                <div class="d-flex gap-2">
                    <a class="btn btn-primary" href="{{ route('movimientos.crear', ['tipo' => 'ENTRADA']) }}"><i class="bi bi-plus-lg"></i> Entra</a>
                    <a class="btn btn-outline-primary" href="{{ route('movimientos.crear', ['tipo' => 'SALIDA']) }}">Sale</a>
                </div>
            @endif
        </div>

        <form method="get" class="d-flex flex-wrap gap-2 mb-3">
            <select class="form-select flex-fill" style="min-width:10rem" name="tipo" aria-label="Tipo de movimiento">
                <option value="">Todos los tipos</option>
                @foreach (\App\Support\Formato::TIPOS as $codigo => [$nombre])
                    <option value="{{ $codigo }}" @selected($tipo === $codigo)>{{ $nombre }}</option>
                @endforeach
            </select>
            @if ($puedeElegirBodega && count($bodegas))
                <select class="form-select flex-fill" style="min-width:10rem" name="bodega" aria-label="Bodega">
                    <option value="">Todas las bodegas</option>
                    @foreach ($bodegas as $id => $bodega)
                        <option value="{{ $id }}" @selected($idBodega === $id)>{{ $bodega['nombre'] }}</option>
                    @endforeach
                </select>
            @endif
            <button class="btn btn-outline-primary px-4">Filtrar</button>
        </form>

        <div class="tarjeta">
            @if ($fallo)
                @include('partials.no-disponible', ['texto' => 'No pudimos cargar los movimientos.'])
            @elseif (! count($filas))
                <div class="nada">No hay movimientos con ese filtro.</div>
            @else
                @foreach ($filas as $m)
                    @php($signo = \App\Support\Formato::signo($m['tipo']) ?: ($m['cantidad'] <=> 0))
                    <div class="fila-dato">
                        <div class="min-w-0">
                            <div class="fw-semibold">{{ $m['producto']['nombre'] }}</div>
                            <div class="small text-suave">{{ \App\Support\Formato::tipo($m['tipo']) }} · {{ $m['bodega'] }} · {{ \App\Support\Formato::fecha($m['fecha']) }}</div>
                            @if (! empty($m['documento_referencia']))<div class="small text-suave">Ref. {{ $m['documento_referencia'] }}</div>@endif
                        </div>
                        <div class="text-end">
                            <div class="cant {{ $signo > 0 ? 'suma' : ($signo < 0 ? 'resta' : '') }}">{{ $signo > 0 ? '+' : ($signo < 0 ? '−' : '') }}{{ \App\Support\Formato::numero(abs($m['cantidad'])) }}</div>
                            <div class="small text-suave">quedan {{ \App\Support\Formato::numero($m['saldo_resultante']) }}</div>
                        </div>
                    </div>
                @endforeach
            @endif
        </div>
        @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
    @endif
@endsection
