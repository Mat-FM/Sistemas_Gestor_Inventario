"""Reportes (RF11, RF15) e indicadores (RF14), con ms-catalogo, ms-inventario y ms-compras simulados."""

from datetime import date, timedelta

import pytest
import requests

from tests.simulacion import paginado

PRODUCTOS = [
    {"id_producto": 1, "codigo": "CAF-500", "nombre": "Café molido", "id_categoria": 2, "precio": "18500.50",
     "estado": "ACTIVO"},
    {"id_producto": 2, "codigo": "AGU-001", "nombre": "Agua", "id_categoria": 3, "precio": 1500, "estado": "ACTIVO"},
    {"id_producto": 3, "codigo": "GAS-001", "nombre": "=Gaseosa", "id_categoria": 4, "precio": 2500,
     "estado": "ACTIVO"},
    {"id_producto": 4, "codigo": "OLD-001", "nombre": "Viejo", "id_categoria": 2, "precio": 100, "estado": "INACTIVO"},
]
SALDOS = [
    {"id_producto": 1, "id_bodega": 1, "cantidad_disponible": 10},
    {"id_producto": 1, "id_bodega": 2, "cantidad_disponible": "2.5"},
    {"id_producto": 2, "id_bodega": 1, "cantidad_disponible": 0},
    {"id_producto": 4, "id_bodega": 1, "cantidad_disponible": 5},
]
SALIDAS = [
    {"id_movimiento": 9, "fecha": "2026-11-10T10:00:00Z", "tipo": "SALIDA", "id_producto": 2, "id_bodega": 1,
     "cantidad": 30, "saldo_resultante": 0, "id_usuario": 7, "documento_referencia": "FAC-1", "observacion": None},
    {"id_movimiento": 8, "fecha": "2026-11-09T10:00:00Z", "tipo": "SALIDA", "id_producto": 1, "id_bodega": 2,
     "cantidad": 4, "saldo_resultante": 2.5, "id_usuario": 7, "documento_referencia": None, "observacion": "Venta"},
    {"id_movimiento": 7, "fecha": "2026-11-08T10:00:00Z", "tipo": "SALIDA", "id_producto": 1, "id_bodega": 1,
     "cantidad": 1, "saldo_resultante": 10, "id_usuario": 3, "documento_referencia": None, "observacion": None},
]


@pytest.fixture
def datos(servicios):
    """ms-catalogo, ms-inventario y ms-compras con los datos de arriba. Los listados se responden paginados."""
    servicios.responder("/productos", lambda llamada: paginado(PRODUCTOS, llamada))
    servicios.responder("/categorias", [
        {"id_categoria": 2, "nombre": "Bebidas", "id_categoria_padre": None},
        {"id_categoria": 3, "nombre": "Aguas", "id_categoria_padre": 2},
        {"id_categoria": 4, "nombre": "Otros", "id_categoria_padre": None},
    ])
    servicios.responder("/bodegas", [{"id_bodega": 1, "codigo": "B1", "nombre": "Centro"},
                                     {"id_bodega": 2, "codigo": "B2", "nombre": "Norte"}])
    servicios.responder("/saldos", lambda llamada: paginado(
        [s for s in SALDOS if llamada["params"].get("id_bodega") in (None, s["id_bodega"])], llamada))
    servicios.responder("/saldos/bajo-umbral", [{"id_producto": 2, "cantidad_total": 0, "cantidad_minima": 5}])
    servicios.responder("/movimientos", lambda llamada: paginado(SALIDAS, llamada))
    servicios.responder("/lotes", lambda llamada: paginado([{"id_lote": 1}, {"id_lote": 2}], llamada))
    servicios.responder("/ordenes-compra", lambda llamada: {
        "datos": [], "meta": {"total": {"ENVIADA": 2, "RECIBIDA_PARCIAL": 1}[llamada["params"]["estado"]]}})
    return servicios


def test_existencias_por_producto_y_bodega(client, datos):
    respuesta = client.get("/reportes/existencias")

    assert respuesta.status_code == 200
    assert [(f["codigo"], f["bodega"], f["cantidad_disponible"]) for f in respuesta.get_json()] == [
        ("AGU-001", "Centro", 0), ("CAF-500", "Centro", 10), ("CAF-500", "Norte", 2.5), ("OLD-001", "Centro", 5)]


def test_existencias_por_categoria_incluye_sus_subcategorias(client, datos):
    respuesta = client.get("/reportes/existencias?id_categoria=2&id_bodega=1")

    assert [f["codigo"] for f in respuesta.get_json()] == ["AGU-001", "CAF-500", "OLD-001"]
    assert datos.llamadas_a("/saldos")[0]["params"]["id_bodega"] == 1


def test_valorizacion_multiplica_cantidad_por_precio(client, datos):
    respuesta = client.get("/reportes/valorizacion").get_json()

    cafe = next(p for p in respuesta["productos"] if p["codigo"] == "CAF-500")
    assert cafe == {"id_producto": 1, "codigo": "CAF-500", "nombre": "Café molido", "cantidad": 12.5,
                    "precio": 18500.5, "valor": 231256.25}
    assert respuesta["valor_total"] == 231756.25


def test_valorizacion_de_una_bodega(client, datos):
    respuesta = client.get("/reportes/valorizacion?id_bodega=2").get_json()

    assert respuesta == {"productos": [{"id_producto": 1, "codigo": "CAF-500", "nombre": "Café molido",
                                        "cantidad": 2.5, "precio": 18500.5, "valor": 46251.25}],
                         "valor_total": 46251.25}


def test_rotacion_cuenta_solo_salidas_de_productos_activos(client, datos):
    respuesta = client.get("/reportes/rotacion?fecha_desde=2026-11-01&fecha_hasta=2026-11-14&limite=2").get_json()

    assert [(p["codigo"], p["salidas"]) for p in respuesta["mayor_rotacion"]] == [("AGU-001", 30), ("CAF-500", 5)]
    assert [(p["codigo"], p["salidas"]) for p in respuesta["menor_rotacion"]] == [("GAS-001", 0), ("CAF-500", 5)]
    assert datos.llamadas_a("/movimientos")[0]["params"] | {"pagina": 1, "por_pagina": 100} == {
        "tipo": "SALIDA", "fecha_desde": "2026-11-01", "fecha_hasta": "2026-11-14", "pagina": 1, "por_pagina": 100}


def test_rotacion_exige_un_rango_de_fechas_valido(client):
    sin_fechas = client.get("/reportes/rotacion")
    assert sin_fechas.status_code == 422
    assert [d["campo"] for d in sin_fechas.get_json()["error"]["detalles"]] == ["fecha_desde", "fecha_hasta"]

    invertido = client.get("/reportes/rotacion?fecha_desde=2026-11-14&fecha_hasta=2026-11-01")
    assert invertido.get_json()["error"]["detalles"] == [
        {"campo": "fecha_hasta", "mensaje": "El campo fecha_hasta debe ser igual o posterior a fecha_desde."}]

    assert client.get("/reportes/rotacion?fecha_desde=01/11/2026&fecha_hasta=2026-11-14").status_code == 422


def test_kardex_con_los_filtros_de_movimientos(client, datos):
    respuesta = client.get("/reportes/kardex?id_bodega=1&tipo=SALIDA&fecha_desde=2026-11-01")

    primero = respuesta.get_json()[0]
    assert primero | {"observacion": None} == {
        "id_movimiento": 9, "fecha": "2026-11-10T10:00:00Z", "tipo": "SALIDA", "id_producto": 2, "codigo": "AGU-001",
        "nombre": "Agua", "id_bodega": 1, "bodega": "Centro", "cantidad": 30, "saldo_resultante": 0, "id_usuario": 7,
        "documento_referencia": "FAC-1", "observacion": None}
    filtros = datos.llamadas_a("/movimientos")[0]["params"]
    assert (filtros["id_bodega"], filtros["tipo"], filtros["fecha_desde"]) == (1, "SALIDA", "2026-11-01")
    assert "fecha_hasta" not in filtros


def test_kardex_valida_los_filtros(client):
    respuesta = client.get("/reportes/kardex?tipo=ROBO&id_usuario=x&formato=xml")

    assert [d["campo"] for d in respuesta.get_json()["error"]["detalles"]] == ["id_usuario", "tipo", "formato"]


def test_indicadores_con_los_valores_por_defecto(client, datos):
    respuesta = client.get("/indicadores")

    indicadores = respuesta.get_json()
    assert indicadores | {"mayor_rotacion": None} == {
        "valor_total": 231756.25, "productos_bajo_umbral": 1, "productos_agotados": 2, "proximos_a_vencer": 2,
        "mayor_rotacion": None, "ordenes_pendientes": 3}
    assert [p["codigo"] for p in indicadores["mayor_rotacion"]] == ["AGU-001", "CAF-500", "GAS-001"]

    hoy = date.today()
    periodo = datos.llamadas_a("/movimientos")[0]["params"]
    assert (periodo["fecha_desde"], periodo["fecha_hasta"]) == ((hoy - timedelta(days=30)).isoformat(), hoy.isoformat())
    assert datos.llamadas_a("/lotes")[0]["params"]["vence_antes_de"] == (hoy + timedelta(days=30)).isoformat()


def test_indicadores_con_un_periodo_invertido(client):
    assert client.get("/indicadores?fecha_desde=2026-12-01&fecha_hasta=2026-11-01").status_code == 422


def test_un_servicio_caido_responde_503(client, datos):
    datos.responder("/ordenes-compra", requests.ConnectionError("rechazada"))

    respuesta = client.get("/indicadores")

    assert respuesta.status_code == 503
    assert respuesta.get_json()["error"] == {
        "codigo": "SERVICIO_NO_DISPONIBLE", "mensaje": "ms-compras no responde. Intente de nuevo más tarde.",
        "detalles": []}


# ---------- Exportación ----------

def test_exporta_la_valorizacion_a_csv_para_excel(client, datos):
    respuesta = client.get("/reportes/valorizacion?formato=csv")

    assert respuesta.status_code == 200
    assert respuesta.mimetype == "text/csv"
    assert respuesta.headers["Content-Disposition"] == \
        f"attachment; filename=valorizacion-{date.today().isoformat()}.csv"
    assert respuesta.data.startswith(b"\xef\xbb\xbf")  # BOM, para que Excel lea las tildes
    assert respuesta.data.decode("utf-8-sig").splitlines() == [
        "Código;Producto;Cantidad;Precio;Valor",
        "AGU-001;Agua;0;1500;0",
        "CAF-500;Café molido;12,5;18500,5;231256,25",
        "OLD-001;Viejo;5;100;500",
        ";Valor total;;;231756,25",
    ]


def test_el_csv_no_deja_textos_que_excel_ejecute_como_formula(client, datos):
    texto = client.get("/reportes/rotacion?fecha_desde=2026-11-01&fecha_hasta=2026-11-14&formato=csv").data

    assert "Menor rotación;GAS-001;'=Gaseosa;0" in texto.decode("utf-8-sig")


@pytest.mark.parametrize("ruta", [
    "/reportes/existencias?formato=pdf",
    "/reportes/valorizacion?formato=pdf",
    "/reportes/rotacion?fecha_desde=2026-11-01&fecha_hasta=2026-11-14&formato=pdf",
    "/reportes/kardex?tipo=SALIDA&formato=pdf",
    "/reportes/kardex?formato=csv",
    "/reportes/existencias?formato=csv",
])
def test_cada_reporte_se_descarga_como_archivo(client, datos, ruta):
    respuesta = client.get(ruta)

    assert respuesta.status_code == 200
    assert respuesta.headers["Content-Disposition"].startswith("attachment; filename=")
    if "formato=pdf" in ruta:
        assert respuesta.mimetype == "application/pdf"
        assert respuesta.data.startswith(b"%PDF-")


def test_un_pdf_sin_datos_se_genera_igual(client, datos):
    datos.responder("/movimientos", lambda llamada: paginado([], llamada))

    respuesta = client.get("/reportes/kardex?formato=pdf")

    assert respuesta.status_code == 200
    assert respuesta.data.startswith(b"%PDF-")
