<div class="row g-2 align-items-end mb-3 pb-3 border-bottom" data-linea>
    <div class="col-12">
        <label class="form-label small mb-1">Producto</label>
        <select class="form-select" name="lineas[{{ $i }}][id_producto]" data-producto>
            <option value="">Elige el producto</option>
            @foreach ($productos as $id => $p)
                <option value="{{ $id }}" data-precio="{{ rtrim(rtrim(number_format((float) $p['precio'], 2, ',', ''), '0'), ',') }}" @selected((string) ($valores['id_producto'] ?? '') === (string) $id)>{{ $p['nombre'] }} ({{ $p['codigo'] }})</option>
            @endforeach
        </select>
    </div>
    <div class="col-5">
        <label class="form-label small mb-1">Cantidad</label>
        <input class="form-control" name="lineas[{{ $i }}][cantidad]" inputmode="numeric" autocomplete="off" placeholder="0" value="{{ $valores['cantidad'] ?? '' }}">
    </div>
    <div class="col-5">
        <label class="form-label small mb-1">Precio de compra</label>
        <input class="form-control" name="lineas[{{ $i }}][precio]" inputmode="decimal" autocomplete="off" placeholder="0" value="{{ $valores['precio'] ?? '' }}" data-precio>
    </div>
    <div class="col-2 text-end">
        <button type="button" class="btn btn-outline-danger" data-quitar-linea aria-label="Quitar este producto"><i class="bi bi-trash"></i></button>
    </div>
</div>
