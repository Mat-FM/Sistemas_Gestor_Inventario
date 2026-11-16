<?php

namespace App\Http\Controllers;

use Illuminate\Http\Response;
use Illuminate\Support\Facades\File;

/**
 * Documentación OpenAPI del servicio (RNF08): la página de Swagger UI y el documento openapi.yaml.
 * Son archivos estáticos que se entregan tal cual, igual que en el API Gateway.
 */
class DocsController extends Controller
{
    /** GET /docs: página que carga Swagger UI desde un CDN con versión e integridad fijas. */
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
