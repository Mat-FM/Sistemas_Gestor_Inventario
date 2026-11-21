{{-- Paso 1 de un formulario: buscar y elegir el producto. Recibe $accion (ruta), $parametros (los que se conservan), $busqueda, $resultados y $fallo. --}}
<form method="get" action="{{ route($accion) }}" role="search" class="mb-3">
    @foreach ($parametros as $clave => $valor)<input type="hidden" name="{{ $clave }}" value="{{ $valor }}">@endforeach
    <div class="buscador mb-2">
        <i class="bi bi-search"></i>
        <input class="form-control" type="search" name="q" value="{{ $busqueda }}" placeholder="¿Qué producto? Nombre o código" aria-label="Buscar producto" autofocus>
    </div>
    <button class="btn btn-primary w-100">Buscar</button>
</form>
@if ($fallo)
    <div class="tarjeta">@include('partials.no-disponible', ['texto' => 'No pudimos buscar productos. Intenta de nuevo.'])</div>
@elseif ($busqueda !== '' && ! count($resultados))
    <div class="tarjeta nada"><i class="bi bi-search"></i><div>No encontramos «{{ $busqueda }}». Prueba con otra parte del nombre o con el código.</div></div>
@elseif ($busqueda === '')
    <div class="nada"><i class="bi bi-upc-scan"></i><div>Escribe el nombre o el código del producto para empezar.</div></div>
@elseif (count($resultados))
    <div class="tarjeta">
        @foreach ($resultados as $r)
            <a class="fila-dato text-decoration-none text-body" href="{{ route($accion, $parametros + ['id_producto' => $r['id_producto']]) }}">
                <div><div class="fw-semibold">{{ $r['nombre'] }}</div><div class="small text-suave">{{ $r['codigo'] }}</div></div>
                <i class="bi bi-chevron-right text-suave"></i>
            </a>
        @endforeach
    </div>
@endif
