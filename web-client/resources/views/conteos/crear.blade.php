@extends('layouts.app')

@section('titulo', 'Programar conteo')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Programar un conteo', 'volver' => route('conteos.index'), 'textoVolver' => 'Conteos'])

    @if ($fallo)
        <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos cargar las bodegas.'])</div>
    @else
        <form method="post" action="{{ route('conteos.guardar') }}" class="tarjeta" novalidate>
            @csrf
            @include('partials.campo', ['nombre' => 'id_bodega', 'etiqueta' => 'Bodega que se va a contar', 'tipo' => 'select',
                'opciones' => array_map(static fn (array $b) => $b['nombre'], $bodegas), 'vacio' => 'Elige una bodega'])
            @include('partials.campo', ['nombre' => 'fecha_programada', 'etiqueta' => 'Fecha del conteo', 'tipo' => 'date', 'valor' => $hoy,
                'atributos' => 'min="'.$hoy.'"', 'ayuda' => 'Se cuentan todos los productos que tienen existencia en la bodega (hasta 1.000).'])
            <button class="btn btn-primary w-100">Programar conteo</button>
        </form>
    @endif
@endsection
