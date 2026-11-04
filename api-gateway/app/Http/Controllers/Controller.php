<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Usuario;
use Illuminate\Http\Request;

abstract class Controller
{
    /** El usuario que dejó AuthenticateJwt; sin él (cadena de middleware mal armada) es 401 y no un error interno. */
    protected function usuarioActual(Request $request): Usuario
    {
        $usuario = $request->attributes->get('usuario');

        if (! $usuario instanceof Usuario) {
            throw ApiException::noAutenticado();
        }

        return $usuario;
    }
}
