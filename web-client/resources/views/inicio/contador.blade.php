@extends('layouts.app')

@section('titulo', 'Inicio')

@section('contenido')
    @include('partials.saludo', ['frase' => 'Existencias, valorización y kardex al día.'])

    <div class="panel-inicio panel-contador">
        <div class="pi-indicadores">
        @if (! $falloIndicadores)
            @include('partials.indicadores', ['indicadores' => $indicadores])
        @endif
        </div>
        <div class="pi-rotacion">
        @if (! $falloIndicadores && count($indicadores['mayor_rotacion']))
            <section class="tarjeta">
                <h2>Lo que más sale</h2>
                @foreach ($indicadores['mayor_rotacion'] as $r)
                    <div class="fila-dato"><span>{{ $r['nombre'] }}</span><span class="cant">{{ \App\Support\Formato::numero($r['salidas']) }} salidas</span></div>
                @endforeach
                <div class="small text-suave mt-2">En los últimos 30 días.</div>
            </section>
        @endif
        </div>
        <div class="pi-aviso">
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
        </div>
        <div class="pi-tareas">
        <div class="tareas">
            <a class="tarea" href="{{ route('stock') }}"><i class="bi bi-boxes"></i>Existencias</a>
            <a class="tarea" href="{{ route('movimientos.index') }}"><i class="bi bi-arrow-left-right"></i>Movimientos</a>
        </div>
        </div>
        <div class="pi-movimientos">@include('partials.ultimos-movimientos')</div>
    </div>
@endsection
