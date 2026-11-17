<div class="tareas">
    <a class="tarea" href="{{ route('movimientos.crear', ['tipo' => 'ENTRADA']) }}"><i class="bi bi-box-arrow-in-down"></i>Entra mercancía</a>
    <a class="tarea" href="{{ route('movimientos.crear', ['tipo' => 'SALIDA']) }}"><i class="bi bi-box-arrow-up"></i>Sale mercancía</a>
    <a class="tarea" href="{{ route('traslados.crear') }}"><i class="bi bi-arrow-left-right"></i>Trasladar</a>
    <a class="tarea" href="{{ route('stock') }}"><i class="bi bi-search"></i>Consultar stock</a>
</div>
