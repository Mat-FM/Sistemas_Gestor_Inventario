"""Quién puede llamar a cada ruta. Es la misma matriz que aplica el Gateway (Tabla 12 de la Entrega 2, api-gateway/config/gateway_routes.php),
repetida aquí para que el servicio no dependa de que nadie le salte el Gateway (defensa en profundidad, RNF07, RNF09): un rol que no figura
recibe 403 SIN_PERMISO antes de que la ruta haga nada (exigir_rol). La clave es «MÉTODO regla» tal como la declara Flask.
tests/test_permisos_roles.py exige una entrada por cada ruta y la compara con la del Gateway.

Ningún otro servicio llama a las rutas de ms-reportes. Una petición sin X-User-Rol no se restringe nunca (el Gateway siempre manda el rol)."""

from flask import request

from app.errores import ApiError

ADM = "ADMINISTRADOR"
CON = "CONTADOR"

PERMISOS = {
    "GET /reportes/existencias": [ADM, CON],
    "GET /reportes/valorizacion": [ADM, CON],
    "GET /reportes/rotacion": [ADM, CON],
    "GET /reportes/kardex": [ADM, CON],
    "GET /indicadores": [ADM, CON],
    "POST /importaciones": [ADM],
    "GET /importaciones": [ADM],
    "GET /importaciones/<int:id_importacion>": [ADM],
}


def exigir_rol():
    """before_request: 403 SIN_PERMISO si X-User-Rol no figura en PERMISOS para la ruta. Sin rol, o en una ruta sin regla (health, docs), pasa."""
    rol = request.headers.get("X-User-Rol")
    if not rol or request.url_rule is None:
        return
    roles = PERMISOS.get(f"{request.method} {request.url_rule.rule}")
    if roles is not None and rol not in roles:
        raise ApiError(403, "SIN_PERMISO", "Su rol no puede realizar esta operación.")
