@extends('layouts.app')

@section('titulo', 'Usuarios')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Usuarios', 'volver' => route('administrar'), 'textoVolver' => 'Administrar', 'accion' => route('usuarios.create'), 'textoAccion' => 'Nuevo'])

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar los usuarios.'])
        @elseif (! count($usuarios))
            <div class="nada">No hay usuarios.</div>
        @else
            @foreach ($usuarios as $u)
                <div class="fila-dato align-items-start">
                    <div class="min-w-0">
                        <div class="fw-semibold">{{ $u['nombre'] }} @if ($u['id_usuario'] === $yo)<span class="etiqueta info">Tú</span>@endif @if (! $u['activo'])@include('partials.estado', ['activo' => false])@endif</div>
                        <div class="small text-suave text-break">{{ $u['correo'] }}</div>
                        <div class="small text-suave">{{ \App\Support\Roles::nombre($u['rol']) }}@if ($u['id_bodega']) · {{ $bodegas[$u['id_bodega']]['nombre'] ?? 'Bodega #'.$u['id_bodega'] }}@endif
                            @if ($u['debe_cambiar_contrasena']) · <span class="text-warning-emphasis">contraseña temporal</span>@endif</div>
                    </div>
                    <a class="btn btn-sm btn-outline-primary flex-shrink-0" href="{{ route('usuarios.edit', $u['id_usuario']) }}">Editar</a>
                </div>
            @endforeach
        @endif
    </div>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
@endsection
