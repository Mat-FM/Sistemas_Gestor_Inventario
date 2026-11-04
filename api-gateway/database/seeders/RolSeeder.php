<?php

namespace Database\Seeders;

use App\Models\Rol;
use App\Support\Roles;
use Illuminate\Database\Seeder;

class RolSeeder extends Seeder
{
    /**
     * Los cuatro roles del sistema (Tabla 6 de la Entrega 1). Repetirlo no duplica nada: se identifica cada rol
     * por su nombre, así que los id_rol (y los usuarios que los referencian) se conservan.
     */
    public function run(): void
    {
        $descripciones = [
            Roles::ADM => 'Acceso total: usuarios (incluido el restablecimiento de contraseñas), catálogo, proveedores, órdenes de compra, umbrales de stock, reportes y configuración.',
            Roles::OPE => 'Registra entradas, salidas, ajustes, traslados, devoluciones, recepciones y conteos físicos en su bodega.',
            Roles::VEN => 'Consulta el catálogo y las existencias por bodega en tiempo real.',
            Roles::CON => 'Consulta el kardex, el panel de auditoría y la valorización; exporta reportes.',
        ];

        foreach ($descripciones as $nombre => $descripcion) {
            Rol::updateOrCreate(['nombre' => $nombre], ['descripcion' => $descripcion]);
        }
    }
}
