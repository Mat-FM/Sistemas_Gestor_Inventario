"""GET /notificaciones y POST /notificaciones/{id}/leida: cada usuario ve las de su rol."""
from tests.conftest import ADMIN, OPERADOR, VENDEDOR


def test_exige_la_identidad_del_usuario(cliente):
    sin_usuario = cliente.get("/notificaciones")
    assert sin_usuario.status_code == 401
    assert sin_usuario.json["error"]["codigo"] == "NO_AUTENTICADO"
    rol_desconocido = cliente.get("/notificaciones", headers={"X-User-Id": "1", "X-User-Rol": "JEFE"})
    assert rol_desconocido.status_code == 401


def test_cada_usuario_ve_solo_las_de_su_rol(aviso, cliente):
    aviso(id_producto=1)
    aviso(id_producto=2, rol_destinatario="OPERADOR_BODEGA")
    admin = cliente.get("/notificaciones", headers=ADMIN).json
    assert [n["id_producto"] for n in admin["datos"]] == [1]
    operador = cliente.get("/notificaciones", headers=OPERADOR).json
    assert [n["id_producto"] for n in operador["datos"]] == [2]
    assert cliente.get("/notificaciones", headers=VENDEDOR).json["datos"] == []


def test_lista_de_la_mas_reciente_a_la_mas_antigua_con_paginacion(aviso, cliente):
    for producto in range(1, 6):
        aviso(id_producto=producto)
    pagina2 = cliente.get("/notificaciones?pagina=2&por_pagina=2", headers=ADMIN).json
    assert pagina2["meta"] == {"pagina": 2, "por_pagina": 2, "total": 5}
    assert [n["id_producto"] for n in pagina2["datos"]] == [3, 2]


def test_filtra_por_leida_y_por_tipo(aviso, cliente):
    primera = aviso(id_producto=1).json["notificacion"]
    aviso(id_producto=2, tipo="VENCIMIENTO")
    aviso(tipo="ORDEN_RECIBIDA", mensaje="OC-0001")
    cliente.post(f"/notificaciones/{primera['id_notificacion']}/leida", headers=ADMIN)

    sin_leer = cliente.get("/notificaciones?leida=false", headers=ADMIN).json
    assert sin_leer["meta"]["total"] == 2
    leidas = cliente.get("/notificaciones?leida=true", headers=ADMIN).json
    assert [n["id_notificacion"] for n in leidas["datos"]] == [primera["id_notificacion"]]
    vencimientos = cliente.get("/notificaciones?tipo=VENCIMIENTO", headers=ADMIN).json
    assert [n["tipo"] for n in vencimientos["datos"]] == ["VENCIMIENTO"]


def test_rechaza_filtros_no_validos(cliente):
    res = cliente.get("/notificaciones?leida=quizas&tipo=OTRO&pagina=0&por_pagina=500", headers=ADMIN)
    assert res.status_code == 422
    campos = {d["campo"] for d in res.json["error"]["detalles"]}
    assert campos == {"leida", "tipo", "pagina", "por_pagina"}


def test_marca_una_notificacion_como_leida(aviso, cliente):
    creada = aviso(id_producto=1).json["notificacion"]
    res = cliente.post(f"/notificaciones/{creada['id_notificacion']}/leida", headers=ADMIN)
    assert res.status_code == 200
    assert res.json["leida"] is True
    # Marcarla otra vez no es un error.
    assert cliente.post(f"/notificaciones/{creada['id_notificacion']}/leida", headers=ADMIN).status_code == 200


def test_no_marca_una_notificacion_de_otro_rol_ni_una_inexistente(aviso, cliente):
    creada = aviso(id_producto=1).json["notificacion"]
    ajena = cliente.post(f"/notificaciones/{creada['id_notificacion']}/leida", headers=VENDEDOR)
    assert ajena.status_code == 404
    assert cliente.get("/notificaciones?leida=false", headers=ADMIN).json["meta"]["total"] == 1
    assert cliente.post("/notificaciones/999/leida", headers=ADMIN).status_code == 404
