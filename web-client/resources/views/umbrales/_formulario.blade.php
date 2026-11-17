<form method="post" action="{{ route('umbrales.update', $idProducto) }}" class="fila-dato fila-acciones" novalidate>
    @csrf @method('PUT')
    <div class="min-w-0">
        <div class="fw-semibold">{{ $nombre }}</div>
        <div class="small text-suave">{{ $detalle }}</div>
    </div>
    <div class="acciones d-flex gap-2 align-items-start">
        <div>
            <input class="form-control text-end" style="width:6.5rem" name="cantidad_minima" inputmode="numeric" autocomplete="off" placeholder="Mínimo"
                   value="{{ $minimo }}" aria-label="Mínimo de {{ $nombre }}">
        </div>
        <button class="btn btn-outline-primary">Guardar</button>
    </div>
</form>
