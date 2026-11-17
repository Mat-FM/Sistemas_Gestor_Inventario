@extends(app(\App\Support\Sesion::class)->activa() ? 'layouts.app' : 'layouts.invitado')

@section('titulo', $titulo)

@section('contenido')
    <div class="tarjeta text-center py-5">
        <i class="bi bi-emoji-neutral fs-1 text-suave"></i>
        <h1 class="h4 mt-2">{{ $titulo }}</h1>
        <p class="text-suave mb-3">{{ $texto }}</p>
        <a class="btn btn-primary" href="{{ route('inicio') }}">Ir al inicio</a>
    </div>
@endsection
