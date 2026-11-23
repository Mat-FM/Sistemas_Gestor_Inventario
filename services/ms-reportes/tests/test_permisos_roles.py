"""Defensa de roles dentro del servicio. El Gateway ya comprueba el rol de cada ruta (Tabla 12), pero el servicio no debe depender de que
nadie le salte el Gateway: cada ruta lleva en app/permisos.py su lista de roles. Estas pruebas comprueban que (1) ninguna ruta se queda sin
regla, (2) la tabla coincide con la matriz del Gateway y (3) un rol que no corresponde recibe 403 antes de que la ruta haga nada."""

import re
from pathlib import Path

import pytest

from app.permisos import PERMISOS

ROLES = ["ADMINISTRADOR", "OPERADOR_BODEGA", "VENDEDOR", "CONTADOR"]
ROL_DE = {"ADM": "ADMINISTRADOR", "OPE": "OPERADOR_BODEGA", "VEN": "VENDEDOR", "CON": "CONTADOR"}
GATEWAY = Path(__file__).resolve().parents[3] / "api-gateway" / "config" / "gateway_routes.php"
SIN_RUTAS_DE_NEGOCIO = {"/health", "/docs", "/docs/openapi.yaml"}


def _normal(ruta):
    """Una sola forma para «/importaciones/<int:id_importacion>» (Flask) e «importaciones/{id}» (Gateway)."""
    return "/" + re.sub(r"<[^>]+>|\{[^}]+\}", "{}", ruta).lstrip("/")


def _declaradas(app):
    claves = set()
    for regla in app.url_map.iter_rules():
        if regla.rule in SIN_RUTAS_DE_NEGOCIO:
            continue
        for metodo in regla.methods - {"HEAD", "OPTIONS"}:
            claves.add(f"{metodo} {regla.rule}")
    return claves


def test_tiene_una_regla_para_cada_ruta_declarada_y_ninguna_de_mas(app):
    assert set(PERMISOS) == _declaradas(app)


def test_cada_regla_es_una_lista_de_roles_validos():
    for regla in PERMISOS.values():
        assert regla and set(regla) <= set(ROLES)


@pytest.mark.skipif(not GATEWAY.exists(), reason="No está la matriz del Gateway (api-gateway/config/gateway_routes.php)")
def test_coincide_con_la_matriz_del_gateway():
    fuente = GATEWAY.read_text(encoding="utf-8")
    reglas = re.findall(r"\['metodo' => '(\w+)', 'ruta' => '([^']+)', 'servicio' => 'ms-reportes', 'roles' => ([^\n]+?)\],?\n", fuente)
    assert len(reglas) == 8
    locales = {_normal(clave.split(" ", 1)[1]) + " " + clave.split(" ", 1)[0]: roles for clave, roles in PERMISOS.items()}
    for metodo, ruta, expresion in reglas:
        roles = ROLES if "Roles::TODOS" in expresion else [ROL_DE[m] for m in re.findall(r"Roles::(\w+)", expresion)]
        assert sorted(locales[_normal(ruta) + " " + metodo]) == sorted(roles), f"{metodo} {ruta}"


CASOS = [(clave, rol, rol in roles) for clave, roles in PERMISOS.items() for rol in ROLES]


@pytest.mark.parametrize("clave, rol, permitido", CASOS, ids=[f"{c}-{r}" for c, r, _ in CASOS])
def test_un_rol_sin_permiso_recibe_403_y_uno_con_permiso_no(client, servicios, clave, rol, permitido):
    metodo, ruta = clave.split(" ", 1)
    ruta = re.sub(r"<[^>]+>", "1", ruta)
    cabeceras = {"X-User-Id": "7", "X-User-Rol": rol}
    respuesta = client.open(ruta, method=metodo, headers=cabeceras)
    if permitido:
        assert respuesta.status_code != 403
    else:
        assert respuesta.status_code == 403
        assert respuesta.get_json()["error"]["codigo"] == "SIN_PERMISO"


def test_una_llamada_interna_sin_rol_no_se_restringe(client, servicios):
    assert client.get("/importaciones").status_code == 200
