@extends('layouts.base')

@section('cuerpo')
    <main class="acceso">
        <div class="w-100" style="max-width:26rem">
            <div class="text-center mb-3">
                <div class="marca fs-4 text-primary"><i class="bi bi-box-seam"></i> El Montañero</div>
                <div class="text-suave">Control de inventario</div>
            </div>
            @include('partials.mensajes')
            @yield('contenido')
        </div>
    </main>
@endsection
