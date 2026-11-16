<?php

use App\Http\Controllers\DocsController;
use App\Http\Controllers\HealthController;
use Illuminate\Support\Facades\Route;

// Rutas propias del servicio, fuera de las operaciones del contrato: /health (RNF10) y /docs (RNF08).
// No pasan por el Gateway (Entrega 2, sección 4.1).
Route::get('/health', HealthController::class);

// Documentación OpenAPI: la página de Swagger UI y el documento que carga.
Route::get('/docs', [DocsController::class, 'interfaz']);
Route::get('/docs/openapi.yaml', [DocsController::class, 'especificacion']);
