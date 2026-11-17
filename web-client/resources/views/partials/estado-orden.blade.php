@php([$etiqueta, $clase] = \App\Support\Formato::ESTADOS_DE_ORDEN[$estado] ?? [$estado, ''])
<span class="etiqueta {{ $clase }}">{{ $etiqueta }}</span>
