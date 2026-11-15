<?php

use App\Http\Controllers\CategoriaController;
use App\Http\Controllers\ProductoController;
use App\Http\Controllers\ProductoLoteController;
use Illuminate\Support\Facades\Route;

/*
 * Rutas del servicio. No llevan el prefijo /api: el Gateway lo quita antes de reenviar la petición
 * (Entrega 2, sección 4.1). Por ejemplo, GET /api/productos llega aquí como GET /productos.
 */

// {id} solo acepta números; cualquier otro valor responde 404.
Route::controller(CategoriaController::class)->where(['id' => '[0-9]+'])->group(function () {
    Route::get('/categorias', 'index');
    Route::post('/categorias', 'store');
    Route::get('/categorias/{id}', 'show');
    Route::put('/categorias/{id}', 'update');
    Route::delete('/categorias/{id}', 'destroy');
});

Route::controller(ProductoController::class)->where(['id' => '[0-9]+'])->group(function () {
    Route::get('/productos', 'index');
    Route::post('/productos', 'store');
    Route::get('/productos/{id}', 'show');
    Route::put('/productos/{id}', 'update');
    Route::post('/productos/{id}/inactivar', 'inactivar');
    Route::post('/productos/{id}/activar', 'activar');
});

// Rutas internas: solo las llaman otros servicios dentro del clúster; el Gateway no las publica.
Route::post('/internas/productos/lote', [ProductoLoteController::class, 'store']);
