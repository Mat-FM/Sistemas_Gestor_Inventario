@extends('layouts.app')

@section('titulo', 'Nuevo traslado')

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        <h1 class="h4 mb-3">Trasladar mercancía</h1>

        @if (! $producto)
            @include('partials.elegir-producto', ['accion' => 'traslados.crear', 'parametros' => [], 'busqueda' => $busqueda, 'resultados' => $resultados, 'fallo' => $fallo])
        @else
            <div class="tarjeta">
                <div class="d-flex justify-content-between align-items-start">
                    <div><h2 class="mb-0">{{ $producto['nombre'] }}</h2><div class="small text-suave">{{ $producto['codigo'] }}</div></div>
                    <a class="small" href="{{ route('traslados.crear') }}">Cambiar</a>
                </div>
                @foreach ($saldos as $s)
                    <div class="fila-dato"><span class="text-suave">Hay en {{ $bodegas[$s['id_bodega']]['nombre'] ?? 'bodega #'.$s['id_bodega'] }}</span><span class="cant">{{ \App\Support\Formato::numero($s['cantidad_disponible']) }}</span></div>
                @endforeach
            </div>

            @if ($idOrigen === null)
                {{-- El administrador elige primero de qué bodega sale: los lotes que se pueden enviar dependen de ella. --}}
                <div class="tarjeta">
                    <h2 class="h6 mb-2">¿De qué bodega sale?</h2>
                    @php $cantidades = collect($saldos)->pluck('cantidad_disponible', 'id_bodega'); @endphp
                    @foreach ($bodegas as $id => $bodega)
                        <a class="fila-dato text-decoration-none" href="{{ route('traslados.crear', ['id_producto' => $producto['id_producto'], 'id_bodega_origen' => $id]) }}">
                            <span>{{ $bodega['nombre'] }}</span><span class="cant">{{ \App\Support\Formato::numero($cantidades[$id] ?? 0) }}</span>
                        </a>
                    @endforeach
                </div>
            @else
            <form method="post" action="{{ route('traslados.guardar') }}" class="tarjeta" novalidate>
                @csrf
                <input type="hidden" name="id_producto" value="{{ $producto['id_producto'] }}">
                <input type="hidden" name="clave" value="{{ old('clave') ?: (string) \Illuminate\Support\Str::uuid() }}">

                <div class="mb-3">
                    <label class="form-label" for="id_bodega_origen">Sale de</label>
                    <input type="hidden" name="id_bodega_origen" value="{{ $idOrigen }}">
                    <input class="form-control" id="id_bodega_origen" value="{{ $bodegas[$idOrigen]['nombre'] ?? ($origenFijo ? 'Tu bodega' : 'Bodega #'.$idOrigen) }}" disabled>
                    @unless ($origenFijo)
                        <a class="small" href="{{ route('traslados.crear', ['id_producto' => $producto['id_producto']]) }}">Cambiar la bodega de origen</a>
                    @endunless
                    @error('id_bodega_origen')<div class="text-danger small">{{ $message }}</div>@enderror
                </div>

                <div class="mb-3">
                    <label class="form-label" for="id_bodega_destino">Va a</label>
                    <select class="form-select @error('id_bodega_destino') is-invalid @enderror" id="id_bodega_destino" name="id_bodega_destino" required>
                        <option value="">Elige la bodega de destino</option>
                        @foreach ($bodegas as $id => $bodega)
                            @continue($id === $idOrigen)
                            <option value="{{ $id }}" @selected((int) old('id_bodega_destino') === $id)>{{ $bodega['nombre'] }}</option>
                        @endforeach
                    </select>
                    @error('id_bodega_destino')<div class="invalid-feedback">{{ $message }}</div>@enderror
                </div>

                {{-- Un traslado mueve un solo lote o solo stock sin lote (ms-inventario): se elige cuál. --}}
                <div class="mb-3">
                    <label class="form-label" for="id_lote">¿De qué lote?</label>
                    @if ($lotes === [] && $sinLote <= 0)
                        <p class="text-suave small mb-0" id="id_lote">{{ $falloLotes ? 'No pudimos consultar los lotes de esta bodega. Intenta de nuevo en unos minutos.' : 'No hay existencias de este producto en esta bodega.' }}</p>
                    @else
                        <select class="form-select @error('id_lote') is-invalid @enderror" id="id_lote" name="id_lote">
                            @foreach ($lotes as $lote)
                                <option value="{{ $lote['id_lote'] }}" @selected((string) old('id_lote', $lotes[0]['id_lote']) === (string) $lote['id_lote'])>
                                    Lote {{ $lote['codigo_lote'] }}{{ $lote['fecha_vencimiento'] ? ' · vence '.\App\Support\Formato::dia($lote['fecha_vencimiento']) : '' }} · {{ \App\Support\Formato::numero($lote['cantidad_disponible']) }} disponibles
                                </option>
                            @endforeach
                            @if ($sinLote > 0)
                                <option value="" @selected($lotes === [] || old('id_lote') === '')>Sin lote · {{ \App\Support\Formato::numero($sinLote) }} disponibles</option>
                            @endif
                        </select>
                        <div class="form-text">Primero aparece el lote que vence antes. Para enviar de varios lotes, haz un traslado por cada uno.</div>
                        @if ($falloLotes)<div class="text-warning small">No pudimos consultar los lotes: por ahora solo se puede enviar stock sin lote.</div>@endif
                        @error('id_lote')<div class="invalid-feedback">{{ $message }}</div>@enderror
                    @endif
                </div>

                <div class="mb-3">
                    <label class="form-label" for="cantidad">¿Cuántas unidades?</label>
                    <input class="form-control form-control-lg @error('cantidad') is-invalid @enderror" id="cantidad" name="cantidad" inputmode="numeric" autocomplete="off" value="{{ old('cantidad') }}" placeholder="0" required>
                    @error('cantidad')<div class="invalid-feedback">{{ $message }}</div>@enderror
                </div>

                <button class="btn btn-primary btn-lg w-100">Enviar traslado</button>
                <p class="text-suave small text-center mt-2 mb-0">La otra bodega tendrá que recibirlo para que el stock suba allá.</p>
            </form>
            @endif
        @endif
    @endif
@endsection
