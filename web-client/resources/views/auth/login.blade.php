@extends('layouts.invitado')

@section('titulo', 'Entrar')

@section('contenido')
    <div class="tarjeta">
        <h1 class="h4 mb-3">Entrar</h1>
        <form method="post" action="{{ route('login.entrar') }}" novalidate>
            @csrf
            <div class="mb-3">
                <label class="form-label" for="correo">Correo</label>
                <input class="form-control form-control-lg @error('correo') is-invalid @enderror" id="correo" name="correo" type="email"
                       inputmode="email" autocomplete="username" value="{{ old('correo') }}" autofocus required>
                @error('correo')<div class="invalid-feedback">{{ $message }}</div>@enderror
            </div>
            <div class="mb-3">
                <label class="form-label" for="contrasena">Contraseña</label>
                <input class="form-control form-control-lg @error('contrasena') is-invalid @enderror" id="contrasena" name="contrasena"
                       type="password" autocomplete="current-password" required>
                @error('contrasena')<div class="invalid-feedback">{{ $message }}</div>@enderror
            </div>
            <button class="btn btn-primary btn-lg w-100">Entrar</button>
        </form>
    </div>
@endsection
