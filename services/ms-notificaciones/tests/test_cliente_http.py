"""Cliente HTTP (RNF18): espera máxima, reintentos y cortacircuito."""
import os
import time

import pytest

from app.clients.http import ClienteHttp, Cortacircuito, ServicioNoDisponible


def _cliente(url, **opciones):
    valores = {"timeout_s": 0.3, "esperas_reintento_s": [0.01, 0.01, 0.01], "fallos_para_abrir": 5, "tiempo_abierto_s": 30}
    valores.update(opciones)
    return ClienteHttp("ms-inventario", url, **valores)


def _url(_inventario):
    """El ms-inventario falso queda en esta dirección (fixture inventario)."""
    return os.environ["MS_INVENTARIO_URL"]


def test_devuelve_el_estado_y_el_cuerpo(inventario):
    inventario.bajo_umbral = [{"id_producto": 1, "cantidad_total": 2, "cantidad_minima": 5}]
    status, cuerpo = _cliente(_url(inventario)).get("/saldos/bajo-umbral")
    assert status == 200
    assert cuerpo[0]["id_producto"] == 1


def test_un_4xx_se_devuelve_sin_reintentar(inventario):
    status, cuerpo = _cliente(_url(inventario)).get("/no-existe")
    assert status == 404
    assert cuerpo["error"]["codigo"] == "RUTA_NO_ENCONTRADA"
    assert len(inventario.peticiones) == 1


def test_reintenta_tres_veces_si_responde_5xx(inventario):
    inventario.modo = "error500"
    with pytest.raises(ServicioNoDisponible, match="respondió 500"):
        _cliente(_url(inventario)).get("/saldos/bajo-umbral")
    assert len(inventario.peticiones) == 4


def test_no_reintenta_si_se_pide_asi(inventario):
    inventario.modo = "error500"
    with pytest.raises(ServicioNoDisponible):
        _cliente(_url(inventario)).get("/saldos/bajo-umbral", reintentar=False)
    assert len(inventario.peticiones) == 1


def test_corta_la_espera_al_superar_el_tiempo_maximo(inventario):
    inventario.modo, inventario.demora_s = "lento", 1
    inicio = time.monotonic()
    with pytest.raises(ServicioNoDisponible, match="no respondió en 0.3 s"):
        _cliente(_url(inventario)).get("/saldos/bajo-umbral", reintentar=False)
    assert time.monotonic() - inicio < 0.9


def test_si_el_servicio_no_existe_falla_rapido_sin_tumbar_nada():
    cliente = _cliente("http://127.0.0.1:9")  # Puerto cerrado.
    with pytest.raises(ServicioNoDisponible):
        cliente.get("/lotes")


def test_una_respuesta_que_no_es_json_se_devuelve_como_texto(inventario):
    inventario.modo = "no_json"
    status, cuerpo = _cliente(_url(inventario)).get("/lotes")
    assert status == 200
    assert "no es json" in cuerpo["texto"]


def test_el_cortacircuito_se_abre_tras_cinco_fallos_y_deja_de_llamar(inventario):
    inventario.modo = "error500"
    cliente = _cliente(_url(inventario), fallos_para_abrir=5)
    with pytest.raises(ServicioNoDisponible):
        cliente.get("/lotes")  # 4 intentos
    with pytest.raises(ServicioNoDisponible):
        cliente.get("/lotes")  # el 5.º fallo abre el cortacircuito y corta los reintentos
    assert cliente.cortacircuito.estado == "ABIERTO"
    llamadas = len(inventario.peticiones)
    with pytest.raises(ServicioNoDisponible, match="cortacircuito abierto"):
        cliente.get("/lotes")
    assert len(inventario.peticiones) == llamadas


def test_el_cortacircuito_deja_pasar_una_prueba_al_terminar_el_tiempo_y_se_cierra_con_exito():
    cortacircuito = Cortacircuito("x", fallos_para_abrir=1, tiempo_abierto_s=0.05)
    cortacircuito.fallo()
    assert cortacircuito.estado == "ABIERTO"
    time.sleep(0.06)
    assert cortacircuito.permite()
    cortacircuito.exito()
    assert cortacircuito.estado == "CERRADO"
    assert cortacircuito.fallos_seguidos == 0
