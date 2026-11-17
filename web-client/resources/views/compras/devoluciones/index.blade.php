@extends('layouts.app')

@section('titulo', 'Devoluciones a proveedor')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Compras', 'accion' => route('compras.devoluciones.create'), 'textoAccion' => 'Devolver'])
    @include('partials.pestanas-compras', ['activa' => 'devoluciones'])

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar las devoluciones.'])
        @elseif (! count($filas))
            <div class="nada">Todavía no hay devoluciones a proveedores.</div>
        @else
            @foreach ($filas as $d)
                <div class="fila-dato align-items-start">
                    <div class="min-w-0">
                        <div class="fw-semibold">{{ $d['producto']['nombre'] }} × {{ \App\Support\Formato::numero($d['cantidad']) }}</div>
                        <div class="small text-suave">{{ $d['proveedor'] }} · salió de {{ $d['bodega'] }} · {{ \App\Support\Formato::fecha($d['fecha']) }}</div>
                        <div class="small text-suave">Motivo: {{ $d['motivo'] }}</div>
                    </div>
                </div>
            @endforeach
        @endif
    </div>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
@endsection
