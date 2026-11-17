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

            <form method="post" action="{{ route('traslados.guardar') }}" class="tarjeta" novalidate>
                @csrf
                <input type="hidden" name="id_producto" value="{{ $producto['id_producto'] }}">
                <input type="hidden" name="clave" value="{{ old('clave') ?: (string) \Illuminate\Support\Str::uuid() }}">

                <div class="mb-3">
                    <label class="form-label" for="id_bodega_origen">Sale de</label>
                    @if ($origenFijo)
                        <input type="hidden" name="id_bodega_origen" value="{{ $idOrigen }}">
                        <input class="form-control" id="id_bodega_origen" value="{{ $bodegas[$idOrigen]['nombre'] ?? 'Tu bodega' }}" disabled>
                    @else
                        <select class="form-select @error('id_bodega_origen') is-invalid @enderror" id="id_bodega_origen" name="id_bodega_origen" required>
                            <option value="">Elige la bodega de origen</option>
                            @foreach ($bodegas as $id => $bodega)
                                <option value="{{ $id }}" @selected((int) old('id_bodega_origen', $idOrigen) === $id)>{{ $bodega['nombre'] }}</option>
                            @endforeach
                        </select>
                        @error('id_bodega_origen')<div class="invalid-feedback">{{ $message }}</div>@enderror
                    @endif
                </div>

                <div class="mb-3">
                    <label class="form-label" for="id_bodega_destino">Va a</label>
                    <select class="form-select @error('id_bodega_destino') is-invalid @enderror" id="id_bodega_destino" name="id_bodega_destino" required>
                        <option value="">Elige la bodega de destino</option>
                        @foreach ($bodegas as $id => $bodega)
                            @continue($origenFijo && $id === $idOrigen)
                            <option value="{{ $id }}" @selected((int) old('id_bodega_destino') === $id)>{{ $bodega['nombre'] }}</option>
                        @endforeach
                    </select>
                    @error('id_bodega_destino')<div class="invalid-feedback">{{ $message }}</div>@enderror
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
@endsection
