"""GET y PUT /preferencias/mia."""
from tests.conftest import ADMIN, VENDEDOR


def test_sin_preferencia_guardada_recibir_correo_es_falso(cliente):
    res = cliente.get("/preferencias/mia", headers=VENDEDOR)
    assert res.status_code == 200
    assert res.json == {"id_usuario": 5, "rol": "VENDEDOR", "correo": None, "recibir_correo": False}


def test_guarda_el_correo_y_el_rol_del_usuario(cliente):
    res = cliente.put("/preferencias/mia", headers=ADMIN, json={"correo": " ana@montanero.co ", "recibir_correo": True})
    assert res.status_code == 200
    assert res.json == {"id_usuario": 1, "rol": "ADMINISTRADOR", "correo": "ana@montanero.co", "recibir_correo": True}
    assert cliente.get("/preferencias/mia", headers=ADMIN).json == res.json


def test_sin_correo_no_puede_activar_recibir_correo(cliente):
    res = cliente.put("/preferencias/mia", headers=ADMIN, json={"recibir_correo": True})
    assert res.status_code == 422
    assert res.json["error"]["detalles"][0]["campo"] == "correo"


def test_si_no_envia_el_correo_conserva_el_que_tenia(cliente):
    cliente.put("/preferencias/mia", headers=ADMIN, json={"correo": "ana@montanero.co", "recibir_correo": True})
    res = cliente.put("/preferencias/mia", headers=ADMIN, json={"recibir_correo": False})
    assert res.json["correo"] == "ana@montanero.co"
    assert res.json["recibir_correo"] is False
    otra_vez = cliente.put("/preferencias/mia", headers=ADMIN, json={"recibir_correo": True})
    assert otra_vez.status_code == 200


def test_con_correo_null_lo_borra(cliente):
    cliente.put("/preferencias/mia", headers=ADMIN, json={"correo": "ana@montanero.co", "recibir_correo": False})
    res = cliente.put("/preferencias/mia", headers=ADMIN, json={"correo": None, "recibir_correo": False})
    assert res.json["correo"] is None


def test_actualiza_el_rol_si_el_usuario_cambio_de_rol(cliente):
    cliente.put("/preferencias/mia", headers=ADMIN, json={"correo": "ana@montanero.co", "recibir_correo": True})
    res = cliente.put("/preferencias/mia", headers={"X-User-Id": "1", "X-User-Rol": "CONTADOR"}, json={"recibir_correo": True})
    assert res.json["rol"] == "CONTADOR"


def test_rechaza_datos_no_validos(cliente):
    res = cliente.put("/preferencias/mia", headers=ADMIN, json={"correo": "no-es-correo", "recibir_correo": "si"})
    assert res.status_code == 422
    assert {d["campo"] for d in res.json["error"]["detalles"]} == {"correo", "recibir_correo"}


def test_exige_la_identidad_del_usuario(cliente):
    assert cliente.get("/preferencias/mia").status_code == 401
    assert cliente.put("/preferencias/mia", json={"recibir_correo": False}).status_code == 401
