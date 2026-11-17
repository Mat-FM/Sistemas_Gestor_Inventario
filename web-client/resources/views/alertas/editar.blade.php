@extends('layouts.app')

@section('titulo', 'Configurar alertas')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Configurar alertas', 'volver' => route('administrar'), 'textoVolver' => 'Administrar'])

    @if ($fallo)
        <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos cargar la configuración.'])</div>
    @else
        <form method="post" action="{{ route('alertas.update') }}" class="tarjeta" style="max-width:36rem" novalidate>
            @csrf @method('PUT')
            <p class="text-suave">Cada día, a la hora que elijas, el sistema revisa qué lotes están por vencer y qué productos están bajo su mínimo, y crea las alertas que falten.</p>
            @include('partials.campo', ['nombre' => 'dias_anticipacion_vencimiento', 'etiqueta' => 'Avisar los vencimientos con', 'valor' => $configuracion['dias_anticipacion_vencimiento'],
                'atributos' => 'inputmode="numeric" autocomplete="off"', 'ayuda' => 'Días de anticipación, de 1 a 365. Con 30, un lote se avisa desde un mes antes de vencer.'])
            @include('partials.campo', ['nombre' => 'hora_revision_diaria', 'etiqueta' => 'Hora de la revisión', 'tipo' => 'time', 'valor' => substr($configuracion['hora_revision_diaria'], 0, 5), 'ayuda' => 'Hora de Colombia.'])
            <button class="btn btn-primary btn-lg w-100">Guardar</button>
        </form>
    @endif
@endsection
