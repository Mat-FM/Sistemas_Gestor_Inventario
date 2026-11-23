"""RNF18 en las llamadas a los demás servicios: tiempo de espera, reintentos y cortacircuitos."""

import pytest
import requests

from app.clients import base, catalogo, proveedores
from app.clients.base import ServicioNoDisponible, llamadas_rapidas
from tests.simulacion import Respuesta


def test_cada_intento_usa_el_tiempo_de_espera_configurado(app, servicios, monkeypatch):
    usados = []
    original = servicios.__call__

    def con_espera(metodo, url, timeout=None, **resto):
        usados.append(timeout)
        return original(metodo, url, timeout=timeout, **resto)

    servicios.responder("/categorias", [])
    monkeypatch.setattr(requests, "request", con_espera)

    catalogo.categorias()

    assert usados == [3.0]


def test_una_consulta_se_reintenta_ante_5xx_y_se_recupera(app, servicios, sin_esperas):
    respuestas = iter([Respuesta(502), Respuesta(503), Respuesta(200, [{"id_categoria": 1}])])
    servicios.responder("/categorias", lambda llamada: next(respuestas))

    assert catalogo.categorias() == [{"id_categoria": 1}]
    assert sin_esperas == [0.2, 0.4]


def test_un_4xx_no_se_reintenta(app, servicios):
    servicios.responder("/categorias", Respuesta(400, {}))

    with pytest.raises(ServicioNoDisponible):
        catalogo.categorias()
    assert len(servicios.llamadas) == 1


def test_un_envio_no_idempotente_no_se_reintenta(app, servicios):
    servicios.responder("/internas/proveedores/lote", requests.Timeout("tardó más de 3 s"))

    with pytest.raises(ServicioNoDisponible):
        proveedores.crear_proveedores([{"nit": "1"}])
    assert len(servicios.llamadas) == 1


def test_una_respuesta_sin_json_es_un_servicio_no_disponible(app, servicios):
    servicios.responder("/categorias", Respuesta(200))

    with pytest.raises(ServicioNoDisponible):
        catalogo.categorias()


def test_un_listado_paginado_con_otra_forma_es_un_servicio_no_disponible(app, servicios):
    servicios.responder("/productos", {"sin": "datos"})

    with pytest.raises(ServicioNoDisponible):
        catalogo.productos()


def test_el_cortacircuitos_se_abre_tras_5_fallos_y_se_cierra_al_volver_a_responder(app, servicios, reloj):
    caido = True
    servicios.responder("/internas/proveedores/lote",
                        lambda llamada: Respuesta(500) if caido else Respuesta(200, {"creados": 0, "rechazados": []}))

    for _ in range(5):
        with pytest.raises(ServicioNoDisponible):
            proveedores.crear_proveedores([])
    assert len(servicios.llamadas) == 5

    # Abierto: falla sin llamar.
    with pytest.raises(ServicioNoDisponible):
        proveedores.crear_proveedores([])
    assert len(servicios.llamadas) == 5

    # Pasados 30 s se vuelve a probar; si responde, el contador vuelve a 0.
    reloj.ahora += base.SEGUNDOS_ABIERTO + 1
    caido = False
    assert proveedores.crear_proveedores([]) == {"creados": 0, "rechazados": []}
    assert base._cortacircuitos["ms-proveedores"]["fallos"] == 0


def test_cada_servicio_tiene_su_propio_cortacircuitos(app, servicios):
    servicios.responder("/internas/proveedores/lote", Respuesta(500))
    servicios.responder("/categorias", [])
    for _ in range(5):
        with pytest.raises(ServicioNoDisponible):
            proveedores.crear_proveedores([])

    assert catalogo.categorias() == []


def test_las_llamadas_rapidas_se_intentan_una_vez_con_plazo_corto(app, servicios, sin_esperas):
    servicios.responder("/categorias", Respuesta(503))

    with llamadas_rapidas(1.0):
        with pytest.raises(ServicioNoDisponible):
            catalogo.categorias()

    assert [llamada["timeout"] for llamada in servicios.llamadas] == [1.0]
    assert sin_esperas == []


def test_fuera_de_las_llamadas_rapidas_vuelve_rnf18(app, servicios, sin_esperas):
    with llamadas_rapidas(1.0):
        pass
    servicios.responder("/categorias", Respuesta(503))

    with pytest.raises(ServicioNoDisponible):
        catalogo.categorias()

    assert len(servicios.llamadas) == 4
    assert sin_esperas == [0.2, 0.4, 0.8]
