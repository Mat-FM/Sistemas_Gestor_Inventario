@php
    $sesion = app(\App\Support\Sesion::class);
    $menu = \App\Support\Roles::menu($sesion->rol());
    $menuMovil = \App\Support\Roles::menuMovil($sesion->rol());
    $rutaActual = request()->route()?->getName();
    $administracion = \App\Support\Roles::administracion($sesion->rol());
    $iniciales = mb_strtoupper(collect(preg_split('/\s+/', trim($sesion->nombre())))->filter()->take(2)->map(fn ($p) => mb_substr($p, 0, 1))->implode(''));
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
    <a class="saltar" href="#contenido">Saltar al contenido</a>

    {{-- Barra lateral (computador y tableta) --}}
    <aside class="lateral d-none d-md-flex">
        <a class="marca" href="{{ route('inicio') }}" aria-label="El Montañero, inicio">@include('partials.marca')</a>
        <nav aria-label="Secciones" class="d-flex flex-column gap-1 overflow-auto">
            @foreach ($menu as $entrada)
                @continue($entrada['ruta'] === 'administrar')
                <a class="enlace {{ $activo($entrada['ruta']) ? 'activo' : '' }}" href="{{ route($entrada['ruta']) }}"@if ($activo($entrada['ruta'])) aria-current="page"@endif>
                    <i class="bi bi-{{ $entrada['icono'] }}"></i> {{ $entrada['etiqueta'] }}
                </a>
            @endforeach
            <a class="enlace {{ $activo('notificaciones.index') ? 'activo' : '' }}" href="{{ route('notificaciones.index') }}"@if ($activo('notificaciones.index')) aria-current="page"@endif>
                <span class="campana"><i class="bi bi-bell"></i>@if ($alertasSinLeer)<span class="globo">{{ $alertasSinLeer > 99 ? '99+' : $alertasSinLeer }}</span>@endif</span> Alertas
            </a>
            @if (count($administracion))
                <div class="seccion">Administración</div>
                @foreach ($administracion as $seccion)
                    <a class="enlace {{ $activo($seccion['ruta']) ? 'activo' : '' }}" href="{{ route($seccion['ruta']) }}"@if ($activo($seccion['ruta'])) aria-current="page"@endif>
                        <i class="bi bi-{{ $seccion['icono'] }}"></i> {{ $seccion['etiqueta'] }}
                    </a>
                @endforeach
            @endif
        </nav>
        <div class="cuenta">
            <div class="quien">
                <span class="avatar" aria-hidden="true">{{ $iniciales }}</span>
                <div class="min-w-0"><div class="fw-semibold text-white text-truncate">{{ $sesion->nombre() }}</div>
                    <div class="small" style="color:#e0a032">{{ \App\Support\Roles::nombre($sesion->rol()) }}</div></div>
            </div>
            <div class="cuenta-acciones">
                <a class="enlace" href="{{ route('preferencias.edit') }}" title="Alertas por correo" aria-label="Alertas por correo"><i class="bi bi-envelope"></i></a>
                <a class="enlace" href="{{ route('contrasena.editar') }}" title="Cambiar contraseña" aria-label="Cambiar contraseña"><i class="bi bi-key"></i></a>
                <form method="post" action="{{ route('salir') }}" class="flex-fill d-flex">@csrf
                    <button class="enlace border-0 w-100" title="Salir" aria-label="Salir"><i class="bi bi-box-arrow-right"></i></button>
                </form>
            </div>
        </div>
    </aside>

    {{-- Barra superior (celular) --}}
    <header class="barra-superior d-md-none">
        <div class="d-flex align-items-center justify-content-between px-3" style="min-height:3.25rem">
            <a class="marca text-white text-decoration-none d-flex align-items-center gap-2" href="{{ route('inicio') }}" aria-label="El Montañero, inicio"><img class="marca-signo" style="width:2rem;height:2rem;border-radius:.55rem" src="{{ asset('img/marca.svg') }}" alt=""><span class="fs-5">El Montañero</span></a>
            <div class="d-flex align-items-center gap-2">
            <a class="btn btn-sm campana" href="{{ route('notificaciones.index') }}" aria-label="Alertas{{ $alertasSinLeer ? ' ('.$alertasSinLeer.' sin leer)' : '' }}">
                <i class="bi bi-bell fs-5"></i>@if ($alertasSinLeer)<span class="globo">{{ $alertasSinLeer > 99 ? '99+' : $alertasSinLeer }}</span>@endif
            </a>
            <div class="dropdown">
                <button class="btn btn-sm d-flex align-items-center gap-2" data-bs-toggle="dropdown" aria-label="Mi cuenta">
                    <span class="avatar" style="width:2rem;height:2rem;font-size:.78rem" aria-hidden="true">{{ $iniciales }}</span><span class="visually-hidden">{{ $sesion->nombre() }}</span>
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

    <main class="contenedor" id="contenido" tabindex="-1">
        {{-- Escritorio: buscar un producto y ver las alertas desde cualquier pantalla (la tecla «/» enfoca el cuadro) --}}
        <div class="barra-escritorio d-none d-md-flex">
            {{-- En «Stock» y en el inicio del vendedor (que es un cuadro de búsqueda) la propia pantalla ya la trae: no se repite --}}
            @if (! request()->routeIs('stock') && ! ($rutaActual === 'inicio' && $sesion->rol() === \App\Support\Roles::VENDEDOR))
                <form class="buscar-global" method="get" action="{{ route('stock') }}" role="search">
                    <i class="bi bi-search"></i>
                    <input class="form-control" type="search" name="q" id="buscar-global" placeholder="Buscar un producto por nombre o código" aria-label="Buscar producto" autocomplete="off">
                    <kbd aria-hidden="true">/</kbd>
                </form>
            @endif
            <a class="btn btn-outline-primary ms-auto campana-escritorio" href="{{ route('notificaciones.index') }}" aria-label="Alertas{{ $alertasSinLeer ? ' ('.$alertasSinLeer.' sin leer)' : '' }}">
                <span class="campana"><i class="bi bi-bell"></i>@if ($alertasSinLeer)<span class="globo" style="border-color:var(--papel-claro)">{{ $alertasSinLeer > 99 ? '99+' : $alertasSinLeer }}</span>@endif</span>
            </a>
        </div>
        @include('partials.mensajes')
        @yield('contenido')
    </main>

    {{-- Menú inferior (celular) --}}
    @if (count($menuMovil) > 1)
        <nav class="menu-inferior d-md-none" aria-label="Menú principal">
            @foreach ($menuMovil as $entrada)
                <a class="{{ $activo($entrada['ruta']) ? 'activo' : '' }}" href="{{ route($entrada['ruta']) }}"@if ($activo($entrada['ruta'])) aria-current="page"@endif>
                    <i class="bi bi-{{ $entrada['icono'] }}"></i>{{ $entrada['etiqueta'] }}
                </a>
            @endforeach
        </nav>
    @endif
@endsection
