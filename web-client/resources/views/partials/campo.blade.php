{{-- Un control de formulario con su etiqueta, su ayuda y su error. Recibe: nombre, etiqueta y, opcionales, tipo (text, email,
     textarea, select), valor, opciones (para select), vacio, opcional, ayuda y atributos (HTML ya escrito, p. ej. maxlength). --}}
@php
    $id = $id ?? $nombre;
    $tipo = $tipo ?? 'text';
    $valor = old($nombre, $valor ?? '');
@endphp
<div class="mb-3" @if (! empty($contenedor)) id="{{ $contenedor }}" @endif>
    <label class="form-label" for="{{ $id }}">{{ $etiqueta }}@if (! empty($opcional)) <span class="text-suave">(opcional)</span>@endif</label>
    @if ($tipo === 'textarea')
        <textarea class="form-control @error($nombre) is-invalid @enderror" id="{{ $id }}" name="{{ $nombre }}" rows="3" {!! $atributos ?? '' !!}>{{ $valor }}</textarea>
    @elseif ($tipo === 'select')
        <select class="form-select @error($nombre) is-invalid @enderror" id="{{ $id }}" name="{{ $nombre }}" {!! $atributos ?? '' !!}>
            <option value="">{{ $vacio ?? 'Elige una opción' }}</option>
            @foreach ($opciones as $clave => $texto)
                <option value="{{ $clave }}" @selected((string) $valor === (string) $clave)>{{ $texto }}</option>
            @endforeach
        </select>
    @else
        <input class="form-control @error($nombre) is-invalid @enderror" type="{{ $tipo }}" id="{{ $id }}" name="{{ $nombre }}" value="{{ $valor }}" {!! $atributos ?? '' !!}>
    @endif
    @error($nombre)<div class="invalid-feedback">{{ $message }}</div>@enderror
    @if (! empty($ayuda))<div class="form-text">{{ $ayuda }}</div>@endif
</div>
