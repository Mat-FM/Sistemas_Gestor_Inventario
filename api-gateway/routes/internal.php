<?php

use App\Http\Controllers\DocsController;
use Illuminate\Support\Facades\Route;

// Rutas propias del Gateway fuera de /api y sin grupos de middleware (sin JWT ni límite de peticiones):
// /health (RNF10) y /docs (RNF08). Nunca se reenvían a un microservicio, y no se publica nada más.
Route::get('/health', fn () => response()->json(['estado' => 'ok', 'servicio' => 'api-gateway']));

// Documentación OpenAPI del Gateway: la página de Swagger UI y el documento que carga.
Route::get('/docs', [DocsController::class, 'interfaz']);
Route::get('/docs/openapi.yaml', [DocsController::class, 'especificacion']);
