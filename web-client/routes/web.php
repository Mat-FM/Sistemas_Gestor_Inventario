<?php

use App\Http\Controllers\AdministrarController;
use App\Http\Controllers\AlertaController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\BodegaController;
use App\Http\Controllers\CategoriaController;
use App\Http\Controllers\DevolucionController;
use App\Http\Controllers\InicioController;
use App\Http\Controllers\LoteController;
use App\Http\Controllers\MovimientoController;
use App\Http\Controllers\NotificacionController;
use App\Http\Controllers\OrdenCompraController;
use App\Http\Controllers\ProductoController;
use App\Http\Controllers\ProveedorController;
use App\Http\Controllers\ReporteController;
use App\Http\Controllers\StockController;
use App\Http\Controllers\TrasladoController;
use App\Http\Controllers\UmbralController;
use App\Http\Controllers\UsuarioController;
use App\Support\Roles;
use Illuminate\Support\Facades\Route;

Route::get('/login', [AuthController::class, 'formulario'])->name('login');
Route::post('/login', [AuthController::class, 'entrar'])->name('login.entrar');

Route::middleware('sesion')->group(function (): void {
    Route::get('/contrasena', [AuthController::class, 'editarContrasena'])->name('contrasena.editar');
    Route::put('/contrasena', [AuthController::class, 'actualizarContrasena'])->name('contrasena.actualizar');
    Route::post('/salir', [AuthController::class, 'salir'])->name('salir');

    Route::get('/', InicioController::class)->name('inicio');
    Route::get('/stock', [StockController::class, 'index'])->name('stock');

    // Alertas de su rol y su preferencia de correo: todos los roles.
    Route::get('/notificaciones', [NotificacionController::class, 'index'])->name('notificaciones.index');
    Route::post('/notificaciones/{id}/leida', [NotificacionController::class, 'leer'])->whereNumber('id')->name('notificaciones.leer');
    Route::get('/preferencias', [NotificacionController::class, 'preferencias'])->name('preferencias.edit');
    Route::put('/preferencias', [NotificacionController::class, 'guardarPreferencias'])->name('preferencias.update');

    $kardex = 'rol:'.implode(',', [Roles::ADMINISTRADOR, Roles::OPERADOR, Roles::CONTADOR]);
    $operacion = 'rol:'.implode(',', [Roles::ADMINISTRADOR, Roles::OPERADOR]);

    Route::get('/movimientos', [MovimientoController::class, 'index'])->middleware($kardex)->name('movimientos.index');

    Route::middleware($operacion)->group(function (): void {
        Route::get('/lotes', [LoteController::class, 'index'])->name('lotes.index');
        Route::get('/movimientos/nuevo', [MovimientoController::class, 'crear'])->name('movimientos.crear');
        Route::post('/movimientos', [MovimientoController::class, 'guardar'])->name('movimientos.guardar');

        Route::get('/traslados', [TrasladoController::class, 'index'])->name('traslados.index');
        Route::get('/traslados/nuevo', [TrasladoController::class, 'crear'])->name('traslados.crear');
        Route::post('/traslados', [TrasladoController::class, 'guardar'])->name('traslados.guardar');
        Route::post('/traslados/{id}/recepcion', [TrasladoController::class, 'recibir'])->whereNumber('id')->name('traslados.recibir');

        // Compras: el administrador y el operador (que recibe y devuelve en su bodega).
        Route::prefix('compras')->name('compras.')->group(function (): void {
            Route::get('/ordenes', [OrdenCompraController::class, 'index'])->name('ordenes.index');
            Route::get('/ordenes/{id}', [OrdenCompraController::class, 'show'])->whereNumber('id')->name('ordenes.show');
            Route::post('/ordenes/{id}/recepciones', [OrdenCompraController::class, 'recibir'])->whereNumber('id')->name('ordenes.recibir');
            Route::get('/devoluciones', [DevolucionController::class, 'index'])->name('devoluciones.index');
            Route::get('/devoluciones/nuevo', [DevolucionController::class, 'create'])->name('devoluciones.create');
            Route::post('/devoluciones', [DevolucionController::class, 'store'])->name('devoluciones.store');
        });
    });

    // Reportes y auditoría: el administrador y el contador (la matriz de permisos de la Entrega 2).
    Route::middleware('rol:'.Roles::ADMINISTRADOR.','.Roles::CONTADOR)->prefix('reportes')->name('reportes.')->group(function (): void {
        Route::get('/', [ReporteController::class, 'index'])->name('index');
        Route::get('/existencias', [ReporteController::class, 'existencias'])->name('existencias');
        Route::get('/valorizacion', [ReporteController::class, 'valorizacion'])->name('valorizacion');
        Route::get('/rotacion', [ReporteController::class, 'rotacion'])->name('rotacion');
        Route::get('/kardex', [ReporteController::class, 'kardex'])->name('kardex');
    });

    // Administración: solo el administrador (el Gateway vuelve a comprobarlo en cada petición).
    Route::middleware('rol:'.Roles::ADMINISTRADOR)->group(function (): void {
        Route::get('/administrar', AdministrarController::class)->name('administrar');
        Route::get('/administrar/alertas', [AlertaController::class, 'edit'])->name('alertas.edit');
        Route::put('/administrar/alertas', [AlertaController::class, 'update'])->name('alertas.update');

        // Crear y cambiar de estado las órdenes de compra: solo el administrador.
        Route::get('/compras/ordenes/nuevo', [OrdenCompraController::class, 'create'])->name('compras.ordenes.create');
        Route::post('/compras/ordenes', [OrdenCompraController::class, 'store'])->name('compras.ordenes.store');
        Route::post('/compras/ordenes/{id}/estado', [OrdenCompraController::class, 'estado'])->whereNumber('id')->name('compras.ordenes.estado');

        Route::resource('productos', ProductoController::class)->except(['show', 'destroy'])->parameters(['productos' => 'id']);
        Route::post('/productos/{id}/inactivar', [ProductoController::class, 'inactivar'])->whereNumber('id')->name('productos.inactivar');
        Route::post('/productos/{id}/activar', [ProductoController::class, 'activar'])->whereNumber('id')->name('productos.activar');

        Route::resource('categorias', CategoriaController::class)->only(['index', 'store', 'edit', 'update', 'destroy'])->parameters(['categorias' => 'id']);

        Route::resource('proveedores', ProveedorController::class)->except(['destroy'])->parameters(['proveedores' => 'id']);
        Route::post('/proveedores/{id}/inactivar', [ProveedorController::class, 'inactivar'])->whereNumber('id')->name('proveedores.inactivar');
        Route::post('/proveedores/{id}/activar', [ProveedorController::class, 'activar'])->whereNumber('id')->name('proveedores.activar');
        Route::post('/proveedores/{id}/productos', [ProveedorController::class, 'asociar'])->whereNumber('id')->name('proveedores.asociar');
        Route::delete('/proveedores/{id}/productos/{producto}', [ProveedorController::class, 'quitar'])->whereNumber(['id', 'producto'])->name('proveedores.quitar');

        Route::resource('bodegas', BodegaController::class)->except(['show', 'destroy'])->parameters(['bodegas' => 'id']);
        Route::post('/bodegas/{id}/inactivar', [BodegaController::class, 'inactivar'])->whereNumber('id')->name('bodegas.inactivar');
        Route::post('/bodegas/{id}/activar', [BodegaController::class, 'activar'])->whereNumber('id')->name('bodegas.activar');

        Route::get('/umbrales', [UmbralController::class, 'index'])->name('umbrales.index');
        Route::put('/umbrales/{producto}', [UmbralController::class, 'update'])->whereNumber('producto')->name('umbrales.update');

        Route::resource('usuarios', UsuarioController::class)->except(['show', 'destroy'])->parameters(['usuarios' => 'id']);
        Route::post('/usuarios/{id}/inactivar', [UsuarioController::class, 'inactivar'])->whereNumber('id')->name('usuarios.inactivar');
        Route::post('/usuarios/{id}/activar', [UsuarioController::class, 'activar'])->whereNumber('id')->name('usuarios.activar');
        Route::post('/usuarios/{id}/restablecer-contrasena', [UsuarioController::class, 'restablecer'])->whereNumber('id')->name('usuarios.restablecer');
    });
});
