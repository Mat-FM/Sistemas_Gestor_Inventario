@extends('layouts.app')

@section('titulo', $orden['numero'])

@section('contenido')
    @include('partials.encabezado', ['titulo' => $orden['numero'], 'volver' => route('compras.ordenes.index'), 'textoVolver' => 'Compras'])

    <section class="tarjeta">
        <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
            @include('partials.estado-orden', ['estado' => $orden['estado']])
            @if ($puedeEnviar || $puedeAnular)
                <div class="d-flex gap-2">
                    @if ($puedeEnviar)
                        <form method="post" action="{{ route('compras.ordenes.estado', $orden['id_orden']) }}" data-confirmar="¿Enviar la orden {{ $orden['numero'] }} a {{ $proveedor }}?">@csrf
                            <input type="hidden" name="estado" value="ENVIADA"><button class="btn btn-sm btn-primary">Marcar como enviada</button>
                        </form>
                    @endif
                    @if ($puedeAnular)
                        <form method="post" action="{{ route('compras.ordenes.estado', $orden['id_orden']) }}" data-confirmar="¿Anular la orden {{ $orden['numero'] }}? No se puede deshacer.">@csrf
                            <input type="hidden" name="estado" value="ANULADA"><button class="btn btn-sm btn-outline-danger">Anular</button>
                        </form>
                    @endif
                </div>
            @endif
        </div>
        @foreach (['Proveedor' => $proveedor, 'Llega a' => $bodega, 'Se espera el' => \App\Support\Formato::dia($orden['fecha_esperada']), 'Creada' => \App\Support\Formato::fecha($orden['fecha_creacion']), 'Total' => \App\Support\Formato::moneda($orden['total'])] as $etiqueta => $dato)
            <div class="fila-dato"><span class="text-suave">{{ $etiqueta }}</span><span class="text-end fw-semibold">{{ $dato }}</span></div>
        @endforeach
        @if ($esOperadorAjeno)<p class="small text-suave mt-2 mb-0">Esta orden llega a otra bodega: puedes verla, pero solo se recibe en la bodega de destino.</p>@endif
    </section>

    @if ($puedeRecibir)
        <form method="post" action="{{ route('compras.ordenes.recibir', $orden['id_orden']) }}" class="tarjeta" novalidate>
            @csrf
            <input type="hidden" name="clave" value="{{ old('clave') ?: (string) \Illuminate\Support\Str::uuid() }}">
            <h2>Recibir mercancía</h2>
            <p class="small text-suave">Escribe cuánto llegó de cada producto. Si algo no llegó, déjalo vacío. Si el producto tiene lote, ábrelo y anota su vencimiento.</p>
            @error('lineas')<div class="alert alert-danger py-2">{{ $message }}</div>@enderror
            @foreach ($detalles as $d)
                @php($pendiente = $d['cantidad_pedida'] - $d['cantidad_recibida'])
                @continue($pendiente <= 0)
                @php($id = $d['id_detalle'])
                <div class="mb-3 pb-3 border-bottom">
                    <div class="d-flex justify-content-between gap-2">
                        <div><div class="fw-semibold">{{ $d['producto']['nombre'] }}</div><div class="small text-suave">Faltan {{ \App\Support\Formato::numero($pendiente) }} de {{ \App\Support\Formato::numero($d['cantidad_pedida']) }}</div></div>
                        <div style="width:6.5rem"><input class="form-control text-end @error("lineas.$id.cantidad") is-invalid @enderror" name="lineas[{{ $id }}][cantidad]" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="Cantidad recibida de {{ $d['producto']['nombre'] }}" value="{{ old("lineas.$id.cantidad") }}"></div>
                    </div>
                    @error("lineas.$id.cantidad")<div class="invalid-feedback d-block">{{ $message }}</div>@enderror
                    <details class="mt-1" @if (old("lineas.$id.codigo_lote") || $errors->has("lineas.$id.codigo_lote")) open @endif>
                        <summary class="small" style="min-height:2.75rem;display:flex;align-items:center">Tiene lote y vencimiento</summary>
                        <div class="row g-2">
                            <div class="col-6"><input class="form-control @error("lineas.$id.codigo_lote") is-invalid @enderror" name="lineas[{{ $id }}][codigo_lote]" placeholder="Lote" aria-label="Lote" value="{{ old("lineas.$id.codigo_lote") }}"></div>
                            <div class="col-6"><input class="form-control" type="date" name="lineas[{{ $id }}][fecha_vencimiento]" aria-label="Vencimiento" value="{{ old("lineas.$id.fecha_vencimiento") }}"></div>
                        </div>
                        @error("lineas.$id.codigo_lote")<div class="invalid-feedback d-block">{{ $message }}</div>@enderror
                    </details>
                </div>
            @endforeach
            <button class="btn btn-primary btn-lg w-100">Registrar lo recibido</button>
        </form>
    @endif

    <section class="tarjeta">
        <h2>Productos de la orden</h2>
        @foreach ($detalles as $d)
            <div class="fila-dato">
                <div class="min-w-0"><div class="fw-semibold">{{ $d['producto']['nombre'] }}</div><div class="small text-suave">{{ \App\Support\Formato::moneda($d['precio_unitario']) }} c/u · {{ \App\Support\Formato::moneda($d['subtotal']) }}</div></div>
                <div class="text-end"><span class="cant {{ $d['cantidad_recibida'] >= $d['cantidad_pedida'] ? 'suma' : '' }}">{{ \App\Support\Formato::numero($d['cantidad_recibida']) }} / {{ \App\Support\Formato::numero($d['cantidad_pedida']) }}</span><div class="small text-suave">recibidos</div></div>
            </div>
        @endforeach
    </section>

    @if (count($recepciones))
        <section class="tarjeta">
            <h2>Lo que ya llegó</h2>
            @foreach ($recepciones as $r)
                <div class="fila-dato">
                    <div class="min-w-0"><div class="fw-semibold">{{ $r['producto']['nombre'] }} × {{ \App\Support\Formato::numero($r['cantidad']) }}</div>
                        <div class="small text-suave">{{ \App\Support\Formato::fecha($r['fecha']) }}@if ($r['codigo_lote']) · lote {{ $r['codigo_lote'] }} (vence {{ \App\Support\Formato::dia($r['fecha_vencimiento']) }})@endif</div></div>
                </div>
            @endforeach
        </section>
    @endif
@endsection
