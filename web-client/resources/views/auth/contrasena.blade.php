@extends($forzado ? 'layouts.invitado' : 'layouts.app')

@section('titulo', 'Cambiar contraseña')

@section('contenido')
    <div class="tarjeta" style="max-width:30rem">
        <h1 class="h4">{{ $forzado ? 'Elige tu contraseña' : 'Cambiar contraseña' }}</h1>
        @if ($forzado)
            <p class="text-suave">Entraste con una contraseña temporal. Cámbiala para seguir.</p>
        @endif
        <form method="post" action="{{ route('contrasena.actualizar') }}" novalidate>
            @csrf @method('PUT')
            @foreach ([['contrasena_actual', 'Contraseña actual', 'current-password'], ['contrasena_nueva', 'Contraseña nueva', 'new-password'], ['contrasena_nueva_confirmation', 'Repite la contraseña nueva', 'new-password']] as [$campo, $etiqueta, $auto])
                <div class="mb-3">
                    <label class="form-label" for="{{ $campo }}">{{ $etiqueta }}</label>
                    <input class="form-control form-control-lg @error($campo) is-invalid @enderror" id="{{ $campo }}" name="{{ $campo }}" type="password" autocomplete="{{ $auto }}" required>
                    @error($campo)<div class="invalid-feedback">{{ $message }}</div>@enderror
                </div>
            @endforeach
            <p class="text-suave small">Mínimo 8 caracteres, con al menos una letra y un número.</p>
            <button class="btn btn-primary btn-lg w-100">Guardar contraseña</button>
        </form>
        @if ($forzado)
            <form method="post" action="{{ route('salir') }}" class="mt-3 text-center">@csrf
                <button class="btn btn-link text-suave">Salir</button>
            </form>
        @endif
    </div>
@endsection
