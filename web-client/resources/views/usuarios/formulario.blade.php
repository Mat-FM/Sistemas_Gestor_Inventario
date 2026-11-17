@extends('layouts.app')

@php($editando = $usuario !== null)

@section('titulo', $editando ? 'Editar usuario' : 'Nuevo usuario')

@section('contenido')
    @include('partials.encabezado', ['titulo' => $editando ? 'Editar usuario' : 'Nuevo usuario', 'volver' => route('usuarios.index'), 'textoVolver' => 'Usuarios'])

    <form method="post" action="{{ $editando ? route('usuarios.update', $usuario['id_usuario']) : route('usuarios.store') }}" class="tarjeta" style="max-width:36rem" novalidate>
        @csrf
        @if ($editando) @method('PUT') @endif

        @include('partials.campo', ['nombre' => 'nombre', 'etiqueta' => 'Nombre completo', 'valor' => $usuario['nombre'] ?? '', 'atributos' => 'maxlength="100" autocomplete="off"'])
        @include('partials.campo', ['nombre' => 'correo', 'etiqueta' => 'Correo', 'tipo' => 'email', 'valor' => $usuario['correo'] ?? '', 'atributos' => 'maxlength="255" inputmode="email" autocomplete="off"', 'ayuda' => 'Es con lo que entra al sistema.'])
        @include('partials.campo', ['nombre' => 'id_rol', 'etiqueta' => 'Rol', 'tipo' => 'select', 'valor' => $usuario['id_rol'] ?? '', 'opciones' => $roles, 'vacio' => 'Elige el rol',
            'atributos' => 'data-rol-operador="'.($idRolOperador ?? '').'"'])
        @include('partials.campo', ['contenedor' => 'grupo-bodega', 'nombre' => 'id_bodega', 'etiqueta' => 'Bodega', 'tipo' => 'select', 'valor' => $usuario['id_bodega'] ?? '', 'opciones' => $bodegas, 'vacio' => 'Elige la bodega',
            'ayuda' => 'El operador solo puede ver y mover la mercancía de esta bodega.'])

        @unless ($editando)
            <div class="mb-3">
                <label class="form-label" for="contrasena_temporal">Contraseña temporal</label>
                <div class="input-group">
                    <input class="form-control @error('contrasena_temporal') is-invalid @enderror" id="contrasena_temporal" name="contrasena_temporal" autocomplete="off" maxlength="72" spellcheck="false">
                    <button class="btn btn-outline-primary" type="button" data-generar-contrasena="#contrasena_temporal">Generar</button>
                </div>
                @error('contrasena_temporal')<div class="invalid-feedback d-block">{{ $message }}</div>@enderror
                <div class="form-text">Al menos 8 caracteres, con una letra y un número. Anótala para dársela: la persona la cambiará al entrar.</div>
            </div>
        @endunless

        <button class="btn btn-primary btn-lg w-100">{{ $editando ? 'Guardar cambios' : 'Crear usuario' }}</button>
    </form>

    @if ($editando)
        <form method="post" action="{{ route('usuarios.restablecer', $usuario['id_usuario']) }}" class="tarjeta" style="max-width:36rem" novalidate
              data-confirmar="¿Restablecer la contraseña de «{{ $usuario['nombre'] }}»? Se cerrará su sesión actual.">
            @csrf
            <h2>Restablecer contraseña</h2>
            <p class="small text-suave">Si olvidó su contraseña, ponle una temporal. Tendrá que cambiarla al entrar.</p>
            <div class="mb-3">
                <div class="input-group">
                    <input class="form-control @error('contrasena_temporal') is-invalid @enderror" id="contrasena_restablecer" name="contrasena_temporal" autocomplete="off" maxlength="72" spellcheck="false" placeholder="Contraseña temporal" aria-label="Contraseña temporal">
                    <button class="btn btn-outline-primary" type="button" data-generar-contrasena="#contrasena_restablecer">Generar</button>
                </div>
                @error('contrasena_temporal')<div class="invalid-feedback d-block">{{ $message }}</div>@enderror
            </div>
            <button class="btn btn-outline-primary w-100">Restablecer</button>
        </form>

        @if ($usuario['id_usuario'] !== $yo)
            <form method="post" action="{{ route($usuario['activo'] ? 'usuarios.inactivar' : 'usuarios.activar', $usuario['id_usuario']) }}" class="tarjeta" style="max-width:36rem"
                  @if ($usuario['activo']) data-confirmar="¿Inactivar a «{{ $usuario['nombre'] }}»? Ya no podrá entrar al sistema." @endif>@csrf
                <h2>{{ $usuario['activo'] ? 'Dar de baja' : 'Reactivar' }}</h2>
                <p class="small text-suave">{{ $usuario['activo'] ? 'Si ya no trabaja aquí, inactívalo: no podrá entrar, pero se conserva lo que registró.' : 'Este usuario está inactivo y no puede entrar.' }}</p>
                <button class="btn {{ $usuario['activo'] ? 'btn-outline-danger' : 'btn-outline-primary' }} w-100">{{ $usuario['activo'] ? 'Inactivar usuario' : 'Activar usuario' }}</button>
            </form>
        @endif
    @endif
@endsection
