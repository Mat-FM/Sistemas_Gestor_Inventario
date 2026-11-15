<?php

use App\Http\Controllers\ProveedorController;
use App\Http\Controllers\ProveedorLoteController;
use App\Http\Controllers\ProveedorProductoController;
use Illuminate\Support\Facades\Route;

/*
 * Rutas del servicio. No llevan el prefijo /api: el Gateway lo quita antes de reenviar la petición
 * (Entrega 2, sección 4.1). Por ejemplo, GET /api/proveedores llega aquí como GET /proveedores.
 */

// {id} solo acepta números; cualquier otro valor responde 404.
Route::controller(ProveedorController::class)->where(['id' => '[0-9]+'])->group(function () {
    Route::get('/proveedores', 'index');
    Route::post('/proveedores', 'store');
    Route::get('/proveedores/{id}', 'show');
    Route::put('/proveedores/{id}', 'update');
    Route::post('/proveedores/{id}/inactivar', 'inactivar');
    Route::post('/proveedores/{id}/activar', 'activar');
});

Route::controller(ProveedorProductoController::class)->where(['id' => '[0-9]+', 'idProducto' => '[0-9]+'])->group(function () {
    Route::get('/proveedores/{id}/productos', 'index');
    Route::post('/proveedores/{id}/productos', 'store');
    Route::delete('/proveedores/{id}/productos/{idProducto}', 'destroy');
});

// Rutas internas: solo las llaman otros servicios dentro del clúster; el Gateway no las publica.
Route::post('/internas/proveedores/lote', [ProveedorLoteController::class, 'store']);
