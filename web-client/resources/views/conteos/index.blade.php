@extends('layouts.app')

@section('titulo', 'Conteos')

@section('contenido')
    @if ($sinBodega)
        @include('partials.sin-bodega')
    @else
        @include('partials.encabezado', [
            'titulo' => 'Conteos físicos',
            'volver' => route('stock'),
            'textoVolver' => 'Stock',
            'accion' => $puedeProgramar ? route('conteos.crear') : null,
            'textoAccion' => 'Programar',
        ])

        <ul class="nav nav-pills pestanas mb-3">
            @foreach (['todos' => 'Todos', 'PROGRAMADO' => 'Por contar', 'EN_REVISION' => 'En revisión', 'APROBADO' => 'Aprobados'] as $codigo => $nombre)
                <li class="nav-item"><a class="nav-link {{ $estado === $codigo ? 'active' : '' }}"
                    href="{{ route('conteos.index', ['estado' => $codigo]) }}">{{ $nombre }}</a></li>
            @endforeach
        </ul>

        <div class="tarjeta">
            @if ($fallo)
                @include('partials.no-disponible', ['texto' => 'No pudimos cargar los conteos.'])
            @elseif (! count($filas))
                <div class="nada">No hay conteos para mostrar.@if ($puedeProgramar) Programa uno con el botón «Programar».@endif</div>
            @else
                @foreach ($filas as $c)
                    <a class="fila-dato text-decoration-none text-body" href="{{ route('conteos.show', $c['id_conteo']) }}">
                        <div>
                            <div class="fw-semibold">Conteo #{{ $c['id_conteo'] }} · {{ $c['bodega'] }}</div>
                            <div class="small text-suave">
                                Para el {{ \App\Support\Formato::dia($c['fecha_programada']) }}
                                @if ($c['fecha_aprobacion']) · aprobado {{ \App\Support\Formato::fecha($c['fecha_aprobacion']) }}@endif
                            </div>
                        </div>
                        <div class="text-end">
                            @include('conteos._estado', ['estado' => $c['estado']])
                            <i class="bi bi-chevron-right text-suave ms-1"></i>
                        </div>
                    </a>
                @endforeach
            @endif
        </div>
        @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
    @endif
@endsection
