@php
    [$texto, $clase] = match ($estado) {
        'PROGRAMADO' => ['Por contar', 'info'],
        'EN_REVISION' => ['En revisión', 'alerta'],
        'APROBADO' => ['Aprobado', 'ok'],
        default => [$estado, ''],
    };
@endphp
<span class="etiqueta {{ $clase }}">{{ $texto }}</span>
