@extends('layouts.app')

@section('titulo', 'Conteo #'.$conteo['id_conteo'])

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Conteo #'.$conteo['id_conteo'], 'volver' => route('conteos.index'), 'textoVolver' => 'Conteos'])

    <div class="tarjeta">
        <div class="d-flex justify-content-between align-items-start gap-2">
            <div>
                <div class="fw-semibold">{{ $conteo['bodega'] }}</div>
                <div class="small text-suave">Para el {{ \App\Support\Formato::dia($conteo['fecha_programada']) }}</div>
                @if ($conteo['fecha_aprobacion'])<div class="small text-suave">Aprobado {{ \App\Support\Formato::fecha($conteo['fecha_aprobacion']) }}</div>@endif
            </div>
            @include('conteos._estado', ['estado' => $conteo['estado']])
        </div>
        <div class="small text-suave mt-2">
            {{ $contadas }} de {{ count($lineas) }} {{ count($lineas) === 1 ? 'producto contado' : 'productos contados' }}
            @if ($contadas > 0) · {{ $conDiferencia }} con diferencia @endif
        </div>
    </div>

    <form method="post" action="{{ route('conteos.registrar', $conteo['id_conteo']) }}" novalidate>
        @csrf @method('PUT')
        <div class="tarjeta">
            @if (! count($lineas))
                <div class="nada">Este conteo no tiene productos.</div>
            @endif
            @foreach ($lineas as $l)
                @php
                    $id = $l['id_producto'];
                    $error = $errors->first("contadas.$id");
                    $valor = old("contadas.$id", $l['cantidad_contada']);
                    $diferencia = $l['cantidad_contada'] === null ? null : (int) $l['diferencia'];
                @endphp
                <div class="fila-dato">
                    <div>
                        <div class="fw-semibold">{{ $l['producto']['nombre'] }}</div>
                        <div class="small text-suave">{{ $l['producto']['codigo'] }} · el sistema dice {{ \App\Support\Formato::numero($l['cantidad_sistema']) }}</div>
                        @if ($diferencia !== null && $diferencia !== 0)
                            <div class="small {{ $diferencia > 0 ? 'text-success' : 'text-danger' }}">
                                {{ $diferencia > 0 ? 'Sobran' : 'Faltan' }} {{ \App\Support\Formato::numero(abs($diferencia)) }}
                            </div>
                        @elseif ($diferencia === 0)
                            <div class="small text-success"><i class="bi bi-check-circle"></i> Coincide</div>
                        @endif
                    </div>
                    <div style="flex: none; width: 7.5rem">
                        @if ($puedeContar)
                            <input class="form-control text-end @if ($error) is-invalid @endif" type="text" inputmode="numeric" name="contadas[{{ $id }}]"
                                value="{{ $valor }}" placeholder="Contado" aria-label="Cantidad contada de {{ $l['producto']['nombre'] }}">
                            @if ($error)<div class="invalid-feedback">{{ $error }}</div>@endif
                        @else
                            <div class="text-end fw-semibold">{{ $l['cantidad_contada'] === null ? 'Sin contar' : \App\Support\Formato::numero($l['cantidad_contada']) }}</div>
                        @endif
                    </div>
                </div>
            @endforeach
        </div>
        @if ($puedeContar && count($lineas))
            <button class="btn btn-primary w-100 mb-3">Guardar cantidades</button>
        @endif
    </form>

    @if ($puedeAprobar)
        <form method="post" action="{{ route('conteos.aprobar', $conteo['id_conteo']) }}" class="tarjeta"
            onsubmit="return confirm('Al aprobar, el inventario se ajusta a lo contado y no se puede deshacer. ¿Aprobar el conteo?')">
            @csrf
            <input type="hidden" name="clave" value="{{ $clave }}">
            <p class="small text-suave mb-2">Aprobar ajusta el inventario a lo contado: {{ $conDiferencia === 0 ? 'no hay diferencias que ajustar.' : $conDiferencia.' '.($conDiferencia === 1 ? 'producto cambia' : 'productos cambian').' su cantidad.' }}
                Los productos sin contar no se tocan.</p>
            <button class="btn btn-success w-100"><i class="bi bi-check2-circle"></i> Aprobar conteo</button>
        </form>
    @endif
@endsection
