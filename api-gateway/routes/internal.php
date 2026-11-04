<?php

use Illuminate\Support\Facades\Route;

// Rutas propias del Gateway fuera de /api y sin grupos de middleware: /health (RNF08)
// y, más adelante, /docs (RNF10). Nunca se reenvían a un microservicio.
Route::get('/health', fn () => response()->json(['estado' => 'ok', 'servicio' => 'api-gateway']));
