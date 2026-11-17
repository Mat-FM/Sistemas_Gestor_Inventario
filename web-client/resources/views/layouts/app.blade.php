@php
    $sesion = app(\App\Support\Sesion::class);
    $menu = \App\Support\Roles::menu($sesion->rol());
    $menuMovil = \App\Support\Roles::menuMovil($sesion->rol());
    $rutaActual = request()->route()?->getName();
    $administracion = \App\Support\Roles::administracion($sesion->rol());
    $prefijosDeAdministracion = array_map(fn ($seccion) => explode('.', $seccion['ruta'])[0].'.', $administracion);
    $activo = function (string $ruta) use ($rutaActual, $prefijosDeAdministracion) {
        if ($ruta === 'administrar') {
            return $rutaActual === 'administrar' || str_starts_with((string) $rutaActual, 'compras.')
                || collect($prefijosDeAdministracion)->contains(fn ($prefijo) => str_starts_with((string) $rutaActual, $prefijo));
        }

        return $rutaActual === $ruta || str_starts_with((string) $rutaActual, explode('.', $ruta)[0].'.') && $ruta !== 'inicio';
    };
@endphp
@extends('layouts.base')

@section('clase-cuerpo', 'con-menu')

@section('cuerpo')
    {{-- Barra lateral (computador y tableta) --}}
    <aside class="lateral d-none d-md-flex">
        <a class="marca fs-5 text-primary mb-4 px-2 text-decoration-none" href="{{ route('inicio') }}"><i class="bi bi-box-seam"></i> El Montañero</a>
        <nav class="d-flex flex-column gap-1 overflow-auto">
            @foreach ($menu as $entrada)
                @continue($entrada['ruta'] === 'administrar')
                <a class="enlace {{ $activo($entrada['ruta']) ? 'activo' : '' }}" href="{{ route($entrada['ruta']) }}">
                    <i class="bi bi-{{ $entrada['icono'] }}"></i> {{ $entrada['etiqueta'] }}
                </a>
            @endforeach
            <a class="enlace {{ $activo('notificaciones.index') ? 'activo' : '' }}" href="{{ route('notificaciones.index') }}">
                <span class="campana"><i class="bi bi-bell"></i>@if ($alertasSinLeer)<span class="globo">{{ $alertasSinLeer > 99 ? '99+' : $alertasSinLeer }}</span>@endif</span> Alertas
            </a>
            @if (count($administracion))
                <div class="text-suave small fw-semibold text-uppercase px-3 pt-3 pb-1">Administración</div>
                @foreach ($administracion as $seccion)
                    <a class="enlace {{ $activo($seccion['ruta']) ? 'activo' : '' }}" href="{{ route($seccion['ruta']) }}">
                        <i class="bi bi-{{ $seccion['icono'] }}"></i> {{ $seccion['etiqueta'] }}
                    </a>
                @endforeach
            @endif
        </nav>
        <div class="mt-auto border-top pt-3">
            <div class="fw-semibold">{{ $sesion->nombre() }}</div>
            <div class="text-suave small mb-2">{{ \App\Support\Roles::nombre($sesion->rol()) }}</div>
            <a class="enlace" href="{{ route('preferencias.edit') }}"><i class="bi bi-envelope"></i> Alertas por correo</a>
            <a class="enlace" href="{{ route('contrasena.editar') }}"><i class="bi bi-key"></i> Cambiar contraseña</a>
            <form method="post" action="{{ route('salir') }}">@csrf
                <button class="enlace border-0 bg-transparent w-100 text-start"><i class="bi bi-box-arrow-right"></i> Salir</button>
            </form>
        </div>
    </aside>

    {{-- Barra superior (celular) --}}
    <header class="barra-superior d-md-none">
        <div class="d-flex align-items-center justify-content-between px-3" style="min-height:3.25rem">
            <a class="marca text-white text-decoration-none" href="{{ route('inicio') }}"><i class="bi bi-box-seam"></i> El Montañero</a>
            <div class="d-flex align-items-center gap-2">
            <a class="btn btn-sm campana" href="{{ route('notificaciones.index') }}" aria-label="Alertas{{ $alertasSinLeer ? ' ('.$alertasSinLeer.' sin leer)' : '' }}">
                <i class="bi bi-bell fs-5"></i>@if ($alertasSinLeer)<span class="globo">{{ $alertasSinLeer > 99 ? '99+' : $alertasSinLeer }}</span>@endif
            </a>
            <div class="dropdown">
                <button class="btn btn-sm d-flex align-items-center gap-2" data-bs-toggle="dropdown" aria-label="Mi cuenta">
                    <span class="small">{{ \Illuminate\Support\Str::before($sesion->nombre(), ' ') }}</span><i class="bi bi-person-circle fs-5"></i>
                </button>
                <ul class="dropdown-menu dropdown-menu-end">
                    <li class="dropdown-item-text small text-suave">{{ \App\Support\Roles::nombre($sesion->rol()) }}</li>
                    <li><a class="dropdown-item py-2" href="{{ route('preferencias.edit') }}"><i class="bi bi-envelope"></i> Alertas por correo</a></li>
                    <li><a class="dropdown-item py-2" href="{{ route('contrasena.editar') }}"><i class="bi bi-key"></i> Cambiar contraseña</a></li>
                    <li><form method="post" action="{{ route('salir') }}">@csrf<button class="dropdown-item py-2"><i class="bi bi-box-arrow-right"></i> Salir</button></form></li>
                </ul>
            </div>
            </div>
        </div>
    </header>

    <main class="contenedor">
        @include('partials.mensajes')
        @yield('contenido')
    </main>

    {{-- Menú inferior (celular) --}}
    @if (count($menuMovil) > 1)
        <nav class="menu-inferior d-md-none" aria-label="Menú principal">
            @foreach ($menuMovil as $entrada)
                <a class="{{ $activo($entrada['ruta']) ? 'activo' : '' }}" href="{{ route($entrada['ruta']) }}">
                    <i class="bi bi-{{ $entrada['icono'] }}"></i>{{ $entrada['etiqueta'] }}
                </a>
            @endforeach
        </nav>
    @endif
@endsection
