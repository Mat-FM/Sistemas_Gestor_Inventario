<?php

namespace App\Http\Controllers;

use App\Support\Roles;
use App\Support\Sesion;
use Illuminate\View\View;

/** Puerta de entrada a las pantallas de administración (solo el administrador). */
class AdministrarController extends Controller
{
    public function __invoke(Sesion $sesion): View
    {
        return view('administrar', ['compras' => [...Roles::COMPRAS, ...Roles::CONTEOS, ...Roles::REPORTES], 'secciones' => Roles::administracion($sesion->rol())]);
    }
}
