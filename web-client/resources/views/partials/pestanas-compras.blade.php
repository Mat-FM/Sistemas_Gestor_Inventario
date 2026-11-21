<ul class="nav nav-pills pestanas mb-3">
    <li class="nav-item"><a class="nav-link {{ $activa === 'ordenes' ? 'active' : '' }}" href="{{ route('compras.ordenes.index') }}">Órdenes</a></li>
    <li class="nav-item"><a class="nav-link {{ $activa === 'devoluciones' ? 'active' : '' }}" href="{{ route('compras.devoluciones.index') }}">Devoluciones</a></li>
</ul>
