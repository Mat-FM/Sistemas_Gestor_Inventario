"""GET y PUT /configuracion-alertas."""
from app.services import configuracion
from tests.conftest import ADMIN


def test_devuelve_la_configuracion_inicial(cliente):
    res = cliente.get("/configuracion-alertas", headers=ADMIN)
    assert res.status_code == 200
    assert res.json == {"dias_anticipacion_vencimiento": 30, "hora_revision_diaria": "06:00"}


def test_guarda_la_configuracion_y_reprograma_la_revision_diaria(cliente, monkeypatch):
    llamadas = []
    monkeypatch.setattr(configuracion, "al_cambiar", [lambda: llamadas.append(1)])
    nueva = {"dias_anticipacion_vencimiento": 15, "hora_revision_diaria": "07:30"}
    res = cliente.put("/configuracion-alertas", headers=ADMIN, json=nueva)
    assert res.status_code == 200
    assert res.json == nueva
    assert cliente.get("/configuracion-alertas", headers=ADMIN).json == nueva
    assert llamadas == [1]


def test_rechaza_valores_no_validos(cliente, monkeypatch):
    llamadas = []
    monkeypatch.setattr(configuracion, "al_cambiar", [lambda: llamadas.append(1)])
    for dias, hora in [(0, "06:00"), (366, "06:00"), (True, "06:00"), ("10", "06:00"), (10, "24:00"), (10, "6:00"), (10, None)]:
        res = cliente.put(
            "/configuracion-alertas",
            headers=ADMIN,
            json={"dias_anticipacion_vencimiento": dias, "hora_revision_diaria": hora},
        )
        assert res.status_code == 422, (dias, hora)
    assert llamadas == []
    assert cliente.get("/configuracion-alertas", headers=ADMIN).json["dias_anticipacion_vencimiento"] == 30
