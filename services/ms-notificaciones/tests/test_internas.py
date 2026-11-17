"""POST /internas/notificaciones: avisos de ms-inventario (llamada 3) y ms-compras (llamada 4)."""
from tests.conftest import ADMIN


def test_acepta_el_aviso_de_orden_recibida_con_el_contrato_de_ms_compras(cliente):
    # Mismo cuerpo que arma ms-compras en recepcionesServicio.js.
    res = cliente.post(
        "/internas/notificaciones",
        json={
            "tipo": "ORDEN_RECIBIDA",
            "mensaje": "La orden OC-0007 se recibió completa.",
            "id_bodega": 1,
            "rol_destinatario": "ADMINISTRADOR",
        },
        headers={"X-Request-Id": "req-compras-1"},
    )
    assert res.status_code == 202
    assert res.headers["X-Request-Id"] == "req-compras-1"
    assert res.json["aceptada"] is True
    assert res.json["duplicada"] is False
    assert res.json["notificacion"] == {
        **res.json["notificacion"],
        "tipo": "ORDEN_RECIBIDA",
        "id_bodega": 1,
        "id_producto": None,
        "rol_destinatario": "ADMINISTRADOR",
        "leida": False,
        "correo_enviado": False,
    }
    assert res.json["notificacion"]["fecha"].endswith("Z")


def test_el_rol_destinatario_es_administrador_por_defecto(aviso):
    res = aviso(id_producto=25)
    assert res.status_code == 202
    assert res.json["notificacion"]["rol_destinatario"] == "ADMINISTRADOR"


def test_no_duplica_una_alerta_sin_leer_del_mismo_tipo_y_producto(aviso, cliente):
    assert aviso(id_producto=25).json["duplicada"] is False
    segunda = aviso(id_producto=25, mensaje="Otra vez bajo el mínimo.")
    assert segunda.status_code == 202
    assert segunda.json == {"aceptada": True, "duplicada": True, "notificacion": None}
    # Otro producto, otro tipo u otro rol sí crean alerta.
    assert aviso(id_producto=26).json["duplicada"] is False
    assert aviso(id_producto=25, tipo="VENCIMIENTO").json["duplicada"] is False
    assert aviso(id_producto=25, rol_destinatario="OPERADOR_BODEGA").json["duplicada"] is False
    assert cliente.get("/notificaciones", headers=ADMIN).json["meta"]["total"] == 3


def test_despues_de_leerla_se_puede_crear_otra_igual(aviso, cliente):
    primera = aviso(id_producto=25).json["notificacion"]
    cliente.post(f"/notificaciones/{primera['id_notificacion']}/leida", headers=ADMIN)
    assert aviso(id_producto=25).json["duplicada"] is False


def test_las_ordenes_recibidas_sin_producto_no_se_agrupan(aviso):
    assert aviso(tipo="ORDEN_RECIBIDA", mensaje="OC-0001").json["duplicada"] is False
    assert aviso(tipo="ORDEN_RECIBIDA", mensaje="OC-0002").json["duplicada"] is False


def test_rechaza_datos_no_validos_con_422_y_el_detalle_por_campo(cliente):
    res = cliente.post(
        "/internas/notificaciones",
        json={"tipo": "OTRO", "id_producto": -1, "id_bodega": "1", "rol_destinatario": "JEFE"},
    )
    assert res.status_code == 422
    assert res.json["error"]["codigo"] == "DATOS_INVALIDOS"
    campos = {d["campo"] for d in res.json["error"]["detalles"]}
    assert campos == {"tipo", "mensaje", "id_producto", "id_bodega", "rol_destinatario"}


def test_rechaza_un_mensaje_demasiado_largo(aviso):
    res = aviso(mensaje="x" * 501)
    assert res.status_code == 422


def test_rechaza_un_json_mal_formado_o_que_no_es_objeto(cliente):
    malo = cliente.post("/internas/notificaciones", data="{no es json", content_type="application/json")
    assert malo.status_code == 400
    assert malo.json["error"]["codigo"] == "PETICION_INVALIDA"
    lista = cliente.post("/internas/notificaciones", json=[1, 2])
    assert lista.status_code == 400


def test_acepta_el_aviso_de_stock_bajo_con_el_contrato_de_ms_inventario(cliente):
    # Mismo cuerpo que arma ms-inventario en notificacionesClient.js (sin rol_destinatario).
    res = cliente.post(
        "/internas/notificaciones",
        json={
            "tipo": "STOCK_BAJO",
            "mensaje": "Stock bajo del producto 25 tras un movimiento en la bodega 2: quedan 3 unidades en total y el mínimo es 10.",
            "id_producto": 25,
            "id_bodega": 2,
        },
    )
    assert res.status_code == 202
    notificacion = res.json["notificacion"]
    assert (notificacion["tipo"], notificacion["id_producto"], notificacion["id_bodega"]) == ("STOCK_BAJO", 25, 2)
    assert notificacion["rol_destinatario"] == "ADMINISTRADOR"
