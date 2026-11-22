<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Route;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Defensa de roles dentro del servicio. El Gateway ya comprueba el rol de cada ruta (Tabla 7), pero el servicio no debe depender de
 * que nadie le salte el Gateway: cada ruta lleva en config/permisos.php su lista de roles. Estas pruebas comprueban que (1) ninguna ruta se
 * queda sin regla, (2) la tabla coincide con la matriz del Gateway y (3) un rol que no corresponde recibe 403 antes de que la ruta haga
 * nada. Una petición sin X-User-Rol es una llamada interna (ms-catalogo, ms-compras...) y no se restringe.
 */
class PermisosRolesTest extends TestCase
{
    private const ROLES = ['ADMINISTRADOR', 'OPERADOR_BODEGA', 'VENDEDOR', 'CONTADOR'];

    private const ROL_DE = ['ADM' => 'ADMINISTRADOR', 'OPE' => 'OPERADOR_BODEGA', 'VEN' => 'VENDEDOR', 'CON' => 'CONTADOR'];

    /** @return list<string> las rutas del servicio como «GET productos/{id}», sin /health ni /docs */
    private function rutas(): array
    {
        $claves = [];
        foreach (Route::getRoutes() as $ruta) {
            $uri = $ruta->uri();
            if (in_array($uri, ['health', 'docs', 'docs/openapi.yaml', 'up'], true) || str_starts_with($uri, 'storage')) {
                continue;
            }
            foreach ($ruta->methods() as $metodo) {
                if ($metodo !== 'HEAD') {
                    $claves[] = $metodo.' '.$uri;
                }
            }
        }
        sort($claves);

        return $claves;
    }

    public function test_cada_ruta_declarada_tiene_su_regla_y_no_sobra_ninguna(): void
    {
        $permisos = array_keys(config('permisos.rutas'));
        sort($permisos);

        $this->assertSame($this->rutas(), $permisos);
    }

    public function test_cada_regla_es_null_o_una_lista_de_roles_validos(): void
    {
        foreach (config('permisos.rutas') as $ruta => $roles) {
            if ($roles === null) {
                continue;
            }
            $this->assertNotEmpty($roles, $ruta);
            $this->assertSame([], array_diff($roles, self::ROLES), $ruta);
        }
    }

    public function test_coincide_con_la_matriz_del_gateway(): void
    {
        $gateway = base_path('../../api-gateway/config/gateway_routes.php');
        if (! is_file($gateway)) {
            $this->markTestSkipped('No está la matriz del Gateway (api-gateway/config/gateway_routes.php).');
        }
        preg_match_all("/\['metodo' => '(\w+)', 'ruta' => '([^']+)', 'servicio' => 'ms-catalogo', 'roles' => ([^\n]+?)\],?\n/", file_get_contents($gateway), $reglas, PREG_SET_ORDER);
        $this->assertCount(11, $reglas);

        foreach ($reglas as [, $metodo, $ruta, $expresion]) {
            $roles = str_contains($expresion, 'Roles::TODOS')
                ? self::ROLES
                : array_map(fn ($m) => self::ROL_DE[$m], (preg_match_all('/Roles::(\w+)/', $expresion, $m) ? $m[1] : []));
            $local = config('permisos.rutas')[$metodo.' '.preg_replace('/\{id_producto\}/', '{idProducto}', $ruta)] ?? 'sin regla';
            $this->assertNotSame('sin regla', $local, "$metodo $ruta");
            $this->assertNotNull($local, "$metodo $ruta: solo se exime lo que otro servicio lee con la identidad del usuario");
            sort($roles);
            $esperado = $local;
            sort($esperado);
            $this->assertSame($roles, $esperado, "$metodo $ruta");
        }
    }

    /** @return array<string, array{string, string, bool}> */
    public static function casos(): array
    {
        $casos = [];
        // El proveedor de datos corre antes de arrancar la aplicación: se lee el archivo, no config().
        foreach ((require __DIR__.'/../../config/permisos.php')['rutas'] as $clave => $roles) {
            if ($roles === null) {
                continue;
            }
            foreach (self::ROLES as $rol) {
                $casos["$clave con $rol"] = [$clave, $rol, in_array($rol, $roles, true)];
            }
        }

        return $casos;
    }

    #[DataProvider('casos')]
    public function test_un_rol_sin_permiso_recibe_403_y_uno_con_permiso_no(string $clave, string $rol, bool $permitido): void
    {
        [$metodo, $uri] = explode(' ', $clave, 2);
        $uri = '/'.preg_replace('/\{\w+\}/', '1', $uri);

        $respuesta = $this->json($metodo, $uri, [], ['X-User-Id' => '7', 'X-User-Rol' => $rol]);

        if ($permitido) {
            $this->assertNotSame(403, $respuesta->getStatusCode());
        } else {
            $respuesta->assertStatus(403)->assertJsonPath('error.codigo', 'SIN_PERMISO');
        }
    }

    public function test_una_llamada_interna_sin_rol_no_se_restringe(): void
    {
        $this->assertNotSame(403, $this->json('POST', '/productos', [])->getStatusCode());
    }
}
