@extends('layouts.app')

@section('titulo', 'Alertas')

@section('contenido')
    @include('partials.encabezado', ['titulo' => 'Alertas'])

    <ul class="nav nav-pills pestanas mb-2">
        @foreach (['sin_leer' => 'Sin leer', 'todas' => 'Todas'] as $codigo => $nombre)
            <li class="nav-item"><a class="nav-link {{ $pestana === $codigo ? 'active' : '' }}"
                href="{{ route('notificaciones.index', array_filter(['ver' => $codigo === 'todas' ? 'todas' : null, 'tipo' => $tipo])) }}">{{ $nombre }}</a></li>
        @endforeach
        <li class="nav-item ms-auto"><a class="nav-link" href="{{ route('preferencias.edit') }}"><i class="bi bi-envelope"></i> Por correo</a></li>
    </ul>
    <div class="d-flex flex-wrap gap-2 mb-3">
        @foreach (\App\Support\Formato::TIPOS_DE_ALERTA as $codigo => [$nombre])
            <a class="etiqueta {{ $tipo === $codigo ? 'ok' : '' }} text-decoration-none py-2 px-3" href="{{ route('notificaciones.index', array_filter(['ver' => $pestana === 'todas' ? 'todas' : null, 'tipo' => $tipo === $codigo ? null : $codigo])) }}">{{ $nombre }}</a>
        @endforeach
    </div>

    <div class="tarjeta">
        @if ($fallo)
            @include('partials.no-disponible', ['texto' => 'No pudimos cargar las alertas.'])
        @elseif (! count($alertas))
            <div class="nada"><i class="bi bi-check2-circle fs-3 d-block text-success"></i>{{ $pestana === 'sin_leer' ? 'No tienes alertas sin leer.' : 'Todavía no hay alertas.' }}</div>
        @else
            @foreach ($alertas as $a)
                @php([$etiqueta, $icono, $clase] = \App\Support\Formato::TIPOS_DE_ALERTA[$a['tipo']] ?? [$a['tipo'], 'bell', ''])
                <div class="fila-dato fila-acciones align-items-start {{ $a['leida'] ? 'opacity-75' : '' }}">
                    <div class="d-flex gap-3 min-w-0">
                        <i class="bi bi-{{ $icono }} fs-4 flex-shrink-0 {{ ['alerta' => 'text-warning', 'mal' => 'text-danger', 'ok' => 'text-success'][$clase] ?? '' }}"></i>
                        <div class="min-w-0">
                            <div class="{{ $a['leida'] ? '' : 'fw-semibold' }}">{{ $a['texto'] }}</div>
                            <div class="small text-suave">{{ $etiqueta }} · {{ \App\Support\Formato::fecha($a['fecha']) }}</div>
                            @if ($a['id_producto'])<div class="small mt-1"><a href="{{ route('stock', ['q' => $a['producto'] ?? '']) }}">Ver el stock</a></div>@endif
                        </div>
                    </div>
                    @unless ($a['leida'])
                        <div class="acciones">
                            <form method="post" action="{{ route('notificaciones.leer', $a['id_notificacion']) }}">@csrf
                                <button class="btn btn-sm btn-outline-primary"><i class="bi bi-check2"></i> Marcar leída</button>
                            </form>
                        </div>
                    @endunless
                </div>
            @endforeach
        @endif
    </div>
    <p class="small text-suave">Las alertas son de tu rol: cuando alguien con tu mismo rol marca una como leída, desaparece para todos.</p>
    @if ($meta) @include('partials.paginacion', ['meta' => $meta]) @endif
@endsection
