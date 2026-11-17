@extends('layouts.app')

@section('titulo', 'Inicio')

@section('contenido')
    <h1 class="h4 mb-3">Hola, {{ \Illuminate\Support\Str::before(app(\App\Support\Sesion::class)->nombre(), ' ') }} <span aria-hidden="true">👋</span></h1>

    <section class="tarjeta">
        <h2>Valor del inventario</h2>
        @if ($falloValor)
            @include('partials.no-disponible', ['texto' => 'No pudimos calcular el valor del inventario.'])
        @else
            <div class="cifra">{{ \App\Support\Formato::moneda($valorTotal) }}</div>
            <div class="small text-suave mb-2">Existencias por precio de lista, al día de hoy</div>
            @foreach ($mayores as $p)
                <div class="fila-dato"><span>{{ $p['nombre'] }}</span><span class="cant">{{ \App\Support\Formato::moneda($p['valor']) }}</span></div>
            @endforeach
        @endif
    </section>

    @if (! $falloIndicadores)
        @include('partials.indicadores', ['indicadores' => $indicadores])
        @if (count($indicadores['mayor_rotacion']))
            <section class="tarjeta">
                <h2>Lo que más sale</h2>
                @foreach ($indicadores['mayor_rotacion'] as $r)
                    <div class="fila-dato"><span>{{ $r['nombre'] }}</span><span class="cant">{{ \App\Support\Formato::numero($r['salidas']) }} salidas</span></div>
                @endforeach
                <div class="small text-suave mt-2">En los últimos 30 días.</div>
            </section>
        @endif
    @endif

    <div class="tareas">
        <a class="tarea" href="{{ route('stock') }}"><i class="bi bi-boxes"></i>Existencias</a>
        <a class="tarea" href="{{ route('movimientos.index') }}"><i class="bi bi-arrow-left-right"></i>Movimientos</a>
    </div>

    @include('partials.ultimos-movimientos')
@endsection
