@php
    [$texto, $clase] = match ($estado) {
        'PROCESADA' => ['Sin errores', 'ok'],
        'CON_ERRORES' => ['Con errores', 'alerta'],
        'FALLIDA' => ['No se completó', 'mal'],
        default => [$estado, ''],
    };
@endphp
<span class="etiqueta {{ $clase }}">{{ $texto }}</span>
