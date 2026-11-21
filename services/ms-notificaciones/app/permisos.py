"""Quién puede llamar a cada ruta. Es la misma matriz que aplica el Gateway (Tabla 11 de la Entrega 2, api-gateway/config/gateway_routes.php),
repetida aquí para que el servicio no dependa de que nadie le salte el Gateway (defensa en profundidad, RNF07, RNF09): un rol que no figura
recibe 403 SIN_PERMISO antes de que la ruta haga nada (contexto.exigir_rol). La clave es «MÉTODO regla» tal como la declara Flask.
tests/test_permisos_roles.py exige una entrada por cada ruta y la compara con la del Gateway.

`None` = no se restringe aquí. Una petición sin usuario (X-User-Id) es una llamada interna y tampoco se restringe nunca."""

ADM = "ADMINISTRADOR"
OPE = "OPERADOR_BODEGA"
TODOS = ["ADMINISTRADOR", "OPERADOR_BODEGA", "VENDEDOR", "CONTADOR"]

PERMISOS = {
    "GET /notificaciones": TODOS,
    "POST /notificaciones/<int:id_notificacion>/leida": TODOS,
    "GET /preferencias/mia": TODOS,
    "PUT /preferencias/mia": TODOS,
    "GET /configuracion-alertas": [ADM],
    "PUT /configuracion-alertas": [ADM],
    # Ruta interna (no pasa por el Gateway): la llaman ms-inventario y ms-compras con la identidad de quien hizo el movimiento o la recepción,
    # y solo ADMINISTRADOR y OPERADOR_BODEGA pueden hacerlos.
    "POST /internas/notificaciones": [ADM, OPE],
}
