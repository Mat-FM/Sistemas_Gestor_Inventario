<?php

namespace App\Http\Controllers;

use Illuminate\Http\Response;
use Illuminate\Support\Facades\File;

/**
 * Documentación OpenAPI propia del Gateway (RNF08): la página de Swagger UI y el documento `openapi.yaml`, que
 * describe solo las operaciones que atiende el Gateway (cada microservicio publica la suya).
 *
 * Son archivos estáticos que se entregan tal cual: sin base de datos (RNF13), sin interpretar el YAML en ejecución
 * (`symfony/yaml` es solo de desarrollo) y sin plantillas de Blade, que necesitarían escribir vistas compiladas en
 * `storage/`. Las rutas viven en `routes/internal.php`, sin JWT ni límite de peticiones.
 */
class DocsController extends Controller
{
    /** GET /docs: página que carga Swagger UI desde un CDN con versión e integridad fijas (D14). */
    public function interfaz(): Response
    {
        return response(File::get(resource_path('docs/swagger-ui.html')), 200, [
            'Content-Type' => 'text/html; charset=utf-8',
        ]);
    }

    /** GET /docs/openapi.yaml: el documento, en crudo. */
    public function especificacion(): Response
    {
        return response(File::get(base_path('openapi.yaml')), 200, [
            'Content-Type' => 'application/yaml; charset=utf-8',
        ]);
    }
}
