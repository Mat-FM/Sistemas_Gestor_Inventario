"""Envío de alertas por correo (llamada 9, RF09)."""
import smtplib

import pytest

from app.clients import correo
from app.services import notificaciones
from tests.conftest import ADMIN, VENDEDOR


class SmtpFalso:
    enviados = []
    fallar = False

    def __init__(self, host, port, timeout):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ehlo(self):
        pass

    def has_extn(self, _nombre):
        return True

    def starttls(self):
        pass

    def login(self, usuario, _clave):
        self.usuario = usuario

    def send_message(self, mensaje, to_addrs):
        if SmtpFalso.fallar:
            raise smtplib.SMTPException("servidor caído")
        SmtpFalso.enviados.append({"asunto": mensaje["Subject"], "para": to_addrs, "texto": mensaje.get_content()})


@pytest.fixture
def smtp(monkeypatch):
    SmtpFalso.enviados, SmtpFalso.fallar = [], False
    monkeypatch.setattr(smtplib, "SMTP", SmtpFalso)
    monkeypatch.setattr(
        correo,
        "_smtp",
        {"host": "smtp.prueba", "port": 587, "user": "alertas", "password": "x", "remitente": "alertas@montanero.co"},
    )
    # En las pruebas el correo se envía en línea, sin hilo.
    monkeypatch.setattr(notificaciones, "_en_segundo_plano", lambda funcion, *args: funcion(*args))
    return SmtpFalso


def _preferencia(cliente, cabeceras, correo_usuario, recibir=True):
    cliente.put("/preferencias/mia", headers=cabeceras, json={"correo": correo_usuario, "recibir_correo": recibir})


def test_envia_la_alerta_a_los_usuarios_del_rol_que_activaron_el_correo(smtp, cliente, aviso):
    _preferencia(cliente, ADMIN, "ana@montanero.co")
    _preferencia(cliente, {"X-User-Id": "2", "X-User-Rol": "ADMINISTRADOR"}, "luis@montanero.co")
    _preferencia(cliente, {"X-User-Id": "3", "X-User-Rol": "ADMINISTRADOR"}, "no@montanero.co", recibir=False)
    _preferencia(cliente, VENDEDOR, "vende@montanero.co")

    creada = aviso(id_producto=25, mensaje="El producto 25 está bajo el mínimo.").json["notificacion"]

    assert smtp.enviados == [
        {
            "asunto": "Producto bajo el stock mínimo",
            "para": ["ana@montanero.co", "luis@montanero.co"],
            "texto": "El producto 25 está bajo el mínimo.\n",
        }
    ]
    leida = cliente.get("/notificaciones", headers=ADMIN).json["datos"][0]
    assert leida["id_notificacion"] == creada["id_notificacion"]
    assert leida["correo_enviado"] is True


def test_si_el_envio_falla_la_alerta_sigue_visible_sin_correo_enviado(smtp, cliente, aviso):
    smtp.fallar = True
    _preferencia(cliente, ADMIN, "ana@montanero.co")
    assert aviso(id_producto=25).status_code == 202
    datos = cliente.get("/notificaciones", headers=ADMIN).json["datos"]
    assert len(datos) == 1
    assert datos[0]["correo_enviado"] is False


def test_sin_destinatarios_no_se_envia_nada(smtp, cliente, aviso):
    aviso(id_producto=25)
    assert smtp.enviados == []
    assert cliente.get("/notificaciones", headers=ADMIN).json["datos"][0]["correo_enviado"] is False


def test_una_alerta_repetida_no_se_vuelve_a_enviar(smtp, cliente, aviso):
    _preferencia(cliente, ADMIN, "ana@montanero.co")
    aviso(id_producto=25)
    aviso(id_producto=25)
    assert len(smtp.enviados) == 1


def test_sin_servidor_configurado_no_se_intenta_enviar(monkeypatch, cliente, aviso):
    llamadas = []
    monkeypatch.setattr(notificaciones, "_en_segundo_plano", lambda *a: llamadas.append(a))
    _preferencia(cliente, ADMIN, "ana@montanero.co")
    assert not correo.configurado()
    aviso(id_producto=25)
    assert llamadas == []
    assert correo.enviar(["ana@montanero.co"], "asunto", "texto") is False


def test_un_error_inesperado_al_enviar_no_tumba_el_hilo(monkeypatch):
    def explota(*_):
        raise RuntimeError("base caída")

    monkeypatch.setattr(notificaciones.repo_preferencias, "correos_del_rol", explota)
    notificacion = {"id_notificacion": 1, "tipo": "STOCK_BAJO", "mensaje": "x", "rol_destinatario": "ADMINISTRADOR"}
    assert notificaciones.enviar_por_correo(notificacion) is False
