{{-- Saludo del inicio: según la hora de la distribuidora, con la fecha y lo que cada rol viene a hacer. Recibe `frase`. --}}
@php
    $ahora = now(config('interfaz.zona_horaria'));
    $saludo = $ahora->hour < 12 ? 'Buenos días' : ($ahora->hour < 19 ? 'Buenas tardes' : 'Buenas noches');
    $sesionActual = app(\App\Support\Sesion::class);
@endphp
<header class="saludo">
    <div class="fecha">{{ $ahora->translatedFormat('l, j \d\e F') }}</div>
    <h1>{{ $saludo }}, {{ \Illuminate\Support\Str::before($sesionActual->nombre(), ' ') }}</h1>
    <p>{{ $frase }}</p>
    <span class="rol"><i class="bi bi-person-badge"></i> {{ \App\Support\Roles::nombre($sesionActual->rol()) }}</span>
</header>
