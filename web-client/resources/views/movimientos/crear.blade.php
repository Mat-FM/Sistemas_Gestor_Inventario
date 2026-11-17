@extends('layouts.app')

@php($titulos = ['ENTRADA' => 'Entra mercancía', 'SALIDA' => 'Sale mercancía', 'DEVOLUCION_CLIENTE' => 'Devolución de un cliente', 'AJUSTE' => 'Ajustar el stock'])

@section('titulo', $titulos[$tipo])

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        <h1 class="h4 mb-3">{{ $titulos[$tipo] }}</h1>

        <ul class="nav nav-pills pestanas mb-3">
            @foreach (['ENTRADA' => 'Entra', 'SALIDA' => 'Sale', 'DEVOLUCION_CLIENTE' => 'Devolución', 'AJUSTE' => 'Ajuste'] as $codigo => $nombre)
                <li class="nav-item"><a class="nav-link {{ $tipo === $codigo ? 'active' : '' }}" style="{{ $tipo === $codigo ? 'background:#0f766e' : '' }}"
                    href="{{ route('movimientos.crear', array_filter(['tipo' => $codigo, 'id_producto' => $producto['id_producto'] ?? null, 'id_bodega' => $idBodega ?? null])) }}">{{ $nombre }}</a></li>
            @endforeach
        </ul>

        @if (! $producto)
            @include('partials.elegir-producto', ['accion' => 'movimientos.crear', 'parametros' => ['tipo' => $tipo], 'busqueda' => $busqueda, 'resultados' => $resultados, 'fallo' => $fallo])
        @else
            <div class="tarjeta">
                <div class="d-flex justify-content-between align-items-start">
                    <div><h2 class="mb-0">{{ $producto['nombre'] }}</h2><div class="small text-suave">{{ $producto['codigo'] }}</div></div>
                    <a class="small" href="{{ route('movimientos.crear', ['tipo' => $tipo]) }}">Cambiar</a>
                </div>
                @if (count($saldos))
                    <div class="mt-2">
                        @foreach ($saldos as $s)
                            <div class="fila-dato"><span class="text-suave">Hay en {{ $bodegas[$s['id_bodega']]['nombre'] ?? 'bodega #'.$s['id_bodega'] }}</span><span class="cant">{{ \App\Support\Formato::numero($s['cantidad_disponible']) }}</span></div>
                        @endforeach
                    </div>
                @endif
            </div>

            <form method="post" action="{{ route('movimientos.guardar') }}" class="tarjeta" novalidate>
                @csrf
                <input type="hidden" name="tipo" value="{{ $tipo }}">
                <input type="hidden" name="id_producto" value="{{ $producto['id_producto'] }}">
                <input type="hidden" name="clave" value="{{ old('clave') ?: (string) \Illuminate\Support\Str::uuid() }}">

                <div class="mb-3">
                    <label class="form-label" for="id_bodega">Bodega</label>
                    @if ($bodegaFija)
                        <input type="hidden" name="id_bodega" value="{{ $idBodega }}">
                        <input class="form-control" id="id_bodega" value="{{ $bodegas[$idBodega]['nombre'] ?? 'Tu bodega' }}" disabled>
                    @else
                        <select class="form-select @error('id_bodega') is-invalid @enderror" id="id_bodega" name="id_bodega" required>
                            <option value="">Elige una bodega</option>
                            @foreach ($bodegas as $id => $bodega)
                                <option value="{{ $id }}" @selected((int) old('id_bodega', $idBodega) === $id)>{{ $bodega['nombre'] }}</option>
                            @endforeach
                        </select>
                        @error('id_bodega')<div class="invalid-feedback">{{ $message }}</div>@enderror
                    @endif
                </div>

                @if ($tipo === 'AJUSTE')
                    <fieldset class="mb-3">
                        <legend class="form-label fs-6">¿Qué pasó con el stock?</legend>
                        @foreach (['sube' => 'Hay de más: sube', 'baja' => 'Hay de menos: baja'] as $valor => $texto)
                            <div class="form-check" style="min-height:2.75rem">
                                <input class="form-check-input @error('sentido') is-invalid @enderror" type="radio" name="sentido" id="sentido-{{ $valor }}" value="{{ $valor }}" @checked(old('sentido') === $valor)>
                                <label class="form-check-label" for="sentido-{{ $valor }}">{{ $texto }}</label>
                            </div>
                        @endforeach
                        @error('sentido')<div class="invalid-feedback d-block">{{ $message }}</div>@enderror
                    </fieldset>
                @endif

                <div class="mb-3">
                    <label class="form-label" for="cantidad">{{ ['ENTRADA' => '¿Cuántas unidades entran?', 'SALIDA' => '¿Cuántas unidades salen?', 'DEVOLUCION_CLIENTE' => '¿Cuántas unidades devuelve el cliente?', 'AJUSTE' => '¿Cuántas unidades de diferencia?'][$tipo] }}</label>
                    <input class="form-control form-control-lg @error('cantidad') is-invalid @enderror" id="cantidad" name="cantidad" inputmode="numeric" autocomplete="off"
                           value="{{ old('cantidad') }}" placeholder="0" required>
                    @error('cantidad')<div class="invalid-feedback">{{ $message }}</div>@enderror
                </div>

                @if (in_array($tipo, ['DEVOLUCION_CLIENTE', 'AJUSTE'], true))
                    <div class="mb-3">
                        <label class="form-label" for="observacion">{{ $tipo === 'AJUSTE' ? 'Motivo del ajuste' : 'Motivo de la devolución' }}@if ($tipo !== 'AJUSTE') <span class="text-suave">(opcional)</span>@endif</label>
                        <textarea class="form-control @error('observacion') is-invalid @enderror" id="observacion" name="observacion" rows="2" maxlength="255">{{ old('observacion') }}</textarea>
                        @error('observacion')<div class="invalid-feedback">{{ $message }}</div>@enderror
                    </div>
                @endif

                <div class="mb-3">
                    <label class="form-label" for="documento_referencia">Factura o documento <span class="text-suave">(opcional)</span></label>
                    <input class="form-control @error('documento_referencia') is-invalid @enderror" id="documento_referencia" name="documento_referencia" value="{{ old('documento_referencia') }}" maxlength="100">
                    @error('documento_referencia')<div class="invalid-feedback">{{ $message }}</div>@enderror
                </div>

                @if ($tipo === 'ENTRADA')
                    <details class="mb-3" @if (old('codigo_lote') || old('fecha_vencimiento') || $errors->has('codigo_lote') || $errors->has('fecha_vencimiento')) open @endif>
                        <summary class="mb-2" style="min-height:2.75rem;display:flex;align-items:center">Tiene lote y fecha de vencimiento</summary>
                        <div class="row g-2">
                            <div class="col-12 col-sm-6">
                                <label class="form-label" for="codigo_lote">Lote</label>
                                <input class="form-control @error('codigo_lote') is-invalid @enderror" id="codigo_lote" name="codigo_lote" value="{{ old('codigo_lote') }}">
                                @error('codigo_lote')<div class="invalid-feedback">{{ $message }}</div>@enderror
                            </div>
                            <div class="col-12 col-sm-6">
                                <label class="form-label" for="fecha_vencimiento">Vence</label>
                                <input class="form-control @error('fecha_vencimiento') is-invalid @enderror" id="fecha_vencimiento" name="fecha_vencimiento" type="date" value="{{ old('fecha_vencimiento') }}">
                                @error('fecha_vencimiento')<div class="invalid-feedback">{{ $message }}</div>@enderror
                            </div>
                        </div>
                    </details>
                @elseif (count($lotes))
                    <div class="aviso-info py-2">
                        <div class="fw-semibold mb-1"><i class="bi bi-info-circle"></i> Sale primero el lote que vence antes</div>
                        @foreach ($lotes as $lote)
                            <div class="fila-dato" style="border-color:#c5dcf7">
                                <span>{{ $lote['codigo_lote'] }} <span class="text-suave small">· {{ $lote['bodega'] }}</span></span>
                                <span>
                                    @if (\App\Support\Formato::vencido($lote['fecha_vencimiento']))<span class="etiqueta mal">Vencido</span>@endif
                                    <span class="small">vence {{ \App\Support\Formato::dia($lote['fecha_vencimiento']) }}</span>
                                    · <span class="cant">{{ \App\Support\Formato::numero($lote['cantidad_disponible']) }}</span>
                                </span>
                            </div>
                        @endforeach
                    </div>
                @endif

                <button class="btn btn-primary btn-lg w-100">{{ ['ENTRADA' => 'Guardar entrada', 'SALIDA' => 'Guardar salida', 'DEVOLUCION_CLIENTE' => 'Guardar devolución', 'AJUSTE' => 'Guardar ajuste'][$tipo] }}</button>
            </form>
        @endif
    @endif
@endsection
