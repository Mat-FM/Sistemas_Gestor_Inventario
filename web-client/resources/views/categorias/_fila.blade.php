<div class="fila-dato" @if ($sub) style="padding-left:1.5rem" @endif>
    <div class="min-w-0">
        <div class="{{ $sub ? '' : 'fw-semibold' }}">@if ($sub)<i class="bi bi-arrow-return-right text-suave"></i> @endif{{ $categoria['nombre'] }}</div>
        @if (! empty($categoria['descripcion']))<div class="small text-suave">{{ $categoria['descripcion'] }}</div>@endif
    </div>
    <div class="d-flex gap-2 flex-shrink-0">
        <a class="btn btn-sm btn-outline-primary" href="{{ route('categorias.edit', $categoria['id_categoria']) }}">Editar</a>
        <form method="post" action="{{ route('categorias.destroy', $categoria['id_categoria']) }}" data-confirmar="¿Eliminar la categoría «{{ $categoria['nombre'] }}»? Solo se puede si ningún producto la usa.">@csrf @method('DELETE')
            <button class="btn btn-sm btn-outline-danger" aria-label="Eliminar {{ $categoria['nombre'] }}"><i class="bi bi-trash"></i></button>
        </form>
    </div>
</div>
