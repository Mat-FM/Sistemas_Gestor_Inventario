@extends('layouts.app')

@section('titulo', 'Lotes por vencer')

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        @include('partials.encabezado', ['titulo' => 'Lotes por vencer', 'volver' => route('stock'), 'textoVolver' => 'Stock'])

        <form method="get" class="d-flex flex-wrap gap-2 mb-3">
            <select class="form-select flex-fill" style="min-width:10rem" name="dias" aria-label="Vencen en">
                @foreach ($opcionesDeDias as $d)<option value="{{ $d }}" @selected($dias === $d)>Vencen en los próximos {{ $d }} días</option>@endforeach
            </select>
            @if ($puedeElegirBodega && count($bodegas))
                <select class="form-select flex-fill" style="min-width:10rem" name="bodega" aria-label="Bodega">
                    <option value="">Todas las bodegas</option>
                    @foreach ($bodegas as $id => $b)<option value="{{ $id }}" @selected($idBodega === $id)>{{ $b['nombre'] }}</option>@endforeach
                </select>
            @endif
            <button class="btn btn-outline-primary px-4">Ver</button>
        </form>

        <div class="tarjeta">
            @if ($fallo)
                @include('partials.no-disponible', ['texto' => 'No pudimos consultar los lotes.'])
            @elseif (! count($lotes))
                <div class="nada"><i class="bi bi-check2-circle fs-3 d-block text-success"></i>Ningún lote con existencia vence en los próximos {{ $dias }} días.</div>
            @else
                @foreach ($lotes as $l)
                    <div class="fila-dato align-items-start">
                        <div class="min-w-0">
                            <div class="fw-semibold">{{ $l['producto']['nombre'] }}</div>
                            <div class="small text-suave">Lote {{ $l['codigo_lote'] }} · {{ $l['bodega'] }}</div>
                            <div class="small">
                                @if ($l['dias'] < 0)<span class="etiqueta mal">Vencido hace {{ abs($l['dias']) }} {{ abs($l['dias']) === 1 ? 'día' : 'días' }}</span>
                                @elseif ($l['dias'] === 0)<span class="etiqueta mal">Vence hoy</span>
                                @else<span class="etiqueta {{ $l['dias'] <= 15 ? 'alerta' : 'info' }}">Vence en {{ $l['dias'] }} {{ $l['dias'] === 1 ? 'día' : 'días' }}</span>@endif
                                <span class="text-suave">· {{ \App\Support\Formato::dia($l['fecha_vencimiento']) }}</span>
                            </div>
                        </div>
                        <div class="text-end"><div class="cant">{{ \App\Support\Formato::numero($l['cantidad_disponible']) }}</div><div class="small text-suave">unidades</div></div>
                    </div>
                @endforeach
            @endif
        </div>
        <p class="small text-suave">Al sacar mercancía, el sistema usa primero el lote que vence antes (FEFO). Un lote vencido sigue contando en el stock hasta que se ajuste.</p>
        @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
    @endif
@endsection
