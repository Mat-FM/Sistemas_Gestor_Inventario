<?php

namespace App\Support;

/**
 * Los cuatro roles del sistema (RF07, Tabla 6 de la Entrega 1). Son también los valores de X-User-Rol.
 */
final class Roles
{
    public const ADM = 'ADMINISTRADOR';

    public const OPE = 'OPERADOR_BODEGA';

    public const VEN = 'VENDEDOR';

    public const CON = 'CONTADOR';

    public const TODOS = [self::ADM, self::OPE, self::VEN, self::CON];

    private function __construct() {}
}
