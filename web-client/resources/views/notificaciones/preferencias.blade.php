@extends('layouts.app')

@section('titulo', 'Alertas por correo')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Alertas por correo', 'volver' => route('notificaciones.index'), 'textoVolver' => 'Alertas'])

    @if ($fallo)
        <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos cargar tu preferencia.'])</div>
    @else
        <form method="post" action="{{ route('preferencias.update') }}" class="tarjeta" style="max-width:36rem" novalidate>
            @csrf @method('PUT')
            <p class="text-suave">Además de verlas aquí, puedes recibir las alertas de tu rol en tu correo. Solo se envía si la distribuidora tiene configurado el servidor de correo.</p>
            <div class="form-check form-switch mb-3" style="min-height:2.75rem">
                <input type="hidden" name="recibir_correo" value="0">
                <input class="form-check-input" type="checkbox" role="switch" id="recibir_correo" name="recibir_correo" value="1" @checked(old('recibir_correo', $preferencia['recibir_correo']))>
                <label class="form-check-label" for="recibir_correo">Quiero recibir las alertas por correo</label>
            </div>
            @include('partials.campo', ['nombre' => 'correo', 'etiqueta' => 'Mi correo', 'tipo' => 'email', 'valor' => $preferencia['correo'] ?? '', 'atributos' => 'maxlength="255" inputmode="email" autocomplete="email"'])
            <button class="btn btn-primary btn-lg w-100">Guardar</button>
        </form>
    @endif
@endsection
