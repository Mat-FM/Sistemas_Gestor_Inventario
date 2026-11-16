"""Revisión diaria (llamada 5): vencimientos (RF17) y stock bajo (RF09) desde ms-inventario."""
import threading
from datetime import date, datetime, time

from app.clients import inventario as cliente_inventario
from app.jobs import revision_diaria
from tests.conftest import ADMIN

HOY = date(2026, 11, 16)


def _lote(id_lote, id_producto, vence, id_bodega=1, cantidad=10):
    return {
        "id_lote": id_lote,
        "codigo_lote": f"L-{id_lote:03d}",
        "id_producto": id_producto,
        "id_bodega": id_bodega,
        "fecha_vencimiento": vence,
        "cantidad_disponible": cantidad,
    }


def test_crea_las_alertas_de_vencimiento_y_de_stock_bajo(inventario, cliente):
    inventario.lotes = [_lote(1, 25, "2026-11-20"), _lote(2, 26, "2027-06-01")]
    inventario.bajo_umbral = [{"id_producto": 30, "cantidad_total": 3, "cantidad_minima": 10}]

    resumen = revision_diaria.ejecutar(hoy=HOY)

    assert resumen == {"vencimiento": 1, "stock_bajo": 1, "errores": []}
    # Pide los lotes con existencia que vencen dentro de los 30 días configurados (vence_antes_de es estricto).
    consulta = inventario.peticiones[0]["consulta"]
    assert consulta["vence_antes_de"] == "2026-12-17"
    assert consulta["con_existencia"] == "true"
    datos = cliente.get("/notificaciones", headers=ADMIN).json["datos"]
    por_tipo = {n["tipo"]: n for n in datos}
    assert por_tipo["VENCIMIENTO"]["id_producto"] == 25
    assert por_tipo["VENCIMIENTO"]["id_bodega"] == 1
    assert "L-001" in por_tipo["VENCIMIENTO"]["mensaje"] and "2026-11-20" in por_tipo["VENCIMIENTO"]["mensaje"]
    assert por_tipo["STOCK_BAJO"]["id_producto"] == 30
    assert "3 unidades" in por_tipo["STOCK_BAJO"]["mensaje"]


def test_usa_los_dias_de_anticipacion_configurados(inventario, cliente):
    cliente.put(
        "/configuracion-alertas", headers=ADMIN, json={"dias_anticipacion_vencimiento": 5, "hora_revision_diaria": "06:00"}
    )
    revision_diaria.ejecutar(hoy=HOY)
    assert inventario.peticiones[0]["consulta"]["vence_antes_de"] == "2026-11-22"


def test_incluye_el_lote_que_vence_justo_el_ultimo_dia_de_anticipacion(inventario):
    inventario.lotes = [_lote(1, 25, "2026-12-16"), _lote(2, 26, "2026-12-17"), _lote(3, 27, "2026-11-20", cantidad=0)]
    # Vence el día 30 (entra), el 31 (no entra) y un lote agotado (no entra).
    assert revision_diaria.ejecutar(hoy=HOY)["vencimiento"] == 1


def test_repetir_la_revision_no_duplica_las_alertas_sin_leer(inventario, cliente):
    inventario.lotes = [_lote(1, 25, "2026-11-20"), _lote(2, 25, "2026-11-25", id_bodega=2)]
    inventario.bajo_umbral = [{"id_producto": 30, "cantidad_total": 3, "cantidad_minima": 10}]
    assert revision_diaria.ejecutar(hoy=HOY)["vencimiento"] == 1  # dos lotes del mismo producto: una alerta
    assert revision_diaria.ejecutar(hoy=HOY) == {"vencimiento": 0, "stock_bajo": 0, "errores": []}
    assert cliente.get("/notificaciones", headers=ADMIN).json["meta"]["total"] == 2


def test_recorre_todas_las_paginas_de_lotes(inventario):
    inventario.lotes = [_lote(i, i, "2026-11-20") for i in range(1, 151)]
    assert revision_diaria.ejecutar(hoy=HOY)["vencimiento"] == 150
    consultas = [p["consulta"] for p in inventario.peticiones if p["ruta"] == "/lotes"]
    assert [c["pagina"] for c in consultas] == ["1", "2"]
    # 100 es el máximo por página que acepta ms-inventario.
    assert {c["por_pagina"] for c in consultas} == {"100"}


def test_envia_el_mismo_request_id_a_las_dos_llamadas(inventario):
    revision_diaria.ejecutar(hoy=HOY)
    ids = {p["request_id"] for p in inventario.peticiones}
    assert len(ids) == 1 and None not in ids


def test_ignora_filas_sin_id_de_producto(inventario):
    inventario.lotes = [{"id_lote": 1, "fecha_vencimiento": "2026-11-20"}]
    inventario.bajo_umbral = [{"cantidad_total": 1}]
    assert revision_diaria.ejecutar(hoy=HOY) == {"vencimiento": 0, "stock_bajo": 0, "errores": []}


def test_si_inventario_no_responde_registra_el_fallo_y_no_lanza(inventario, cliente):
    inventario.modo = "error500"
    resumen = revision_diaria.ejecutar(hoy=HOY)
    assert resumen["vencimiento"] == resumen["stock_bajo"] == 0
    assert len(resumen["errores"]) == 2
    # El servicio sigue atendiendo.
    assert cliente.get("/health").status_code == 200
    assert cliente.post("/internas/notificaciones", json={"tipo": "ORDEN_RECIBIDA", "mensaje": "OC-1"}).status_code == 202


def test_si_inventario_no_existe_la_revision_termina(monkeypatch, cliente):
    monkeypatch.setattr(cliente_inventario.cliente, "url_base", "http://127.0.0.1:9")
    resumen = revision_diaria.ejecutar(hoy=HOY)
    assert len(resumen["errores"]) == 2


def test_una_respuesta_sin_lista_de_datos_se_trata_como_fallo(inventario):
    inventario.modo = "no_json"
    resumen = revision_diaria.ejecutar(hoy=HOY)
    assert "sin lista de datos" in resumen["errores"][0]


def test_proxima_ejecucion_es_hoy_si_aun_no_pasa_la_hora_y_si_no_manana():
    assert revision_diaria.proxima_ejecucion(time(6, 0), datetime(2026, 11, 16, 5, 59)) == datetime(2026, 11, 16, 6, 0)
    assert revision_diaria.proxima_ejecucion(time(6, 0), datetime(2026, 11, 16, 6, 0)) == datetime(2026, 11, 17, 6, 0)
    assert revision_diaria.proxima_ejecucion(time(6, 0), datetime(2026, 11, 16, 23, 0)) == datetime(2026, 11, 17, 6, 0)


def test_el_programador_ejecuta_la_revision_a_la_hora_y_se_puede_reprogramar(monkeypatch):
    ejecutada = threading.Event()
    monkeypatch.setattr(revision_diaria, "ejecutar", lambda: ejecutada.set())
    # La próxima ejecución queda en el pasado inmediato: debe correr enseguida.
    monkeypatch.setattr(revision_diaria, "proxima_ejecucion", lambda hora, ahora: ahora)
    programador = revision_diaria.Programador()
    programador.iniciar()
    programador.reprogramar()
    try:
        assert ejecutada.wait(2)
    finally:
        programador.detener()
