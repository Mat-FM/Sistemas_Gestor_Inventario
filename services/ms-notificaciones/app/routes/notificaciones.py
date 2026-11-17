"""Rutas públicas de la Tabla 11 (las publica el Gateway con el prefijo /api).
Los roles por ruta ya los comprueba el Gateway; aquí se filtra por el rol del usuario."""
from flask import Blueprint, request

from ..contexto import usuario_actual
from ..services import configuracion, notificaciones, preferencias
from ..validacion import cuerpo_json

rutas = Blueprint("publicas", __name__)


@rutas.get("/notificaciones")
def listar_notificaciones():
    return notificaciones.listar(usuario_actual(), request.args)


@rutas.post("/notificaciones/<int:id_notificacion>/leida")
def marcar_leida(id_notificacion):
    return notificaciones.marcar_leida(usuario_actual(), id_notificacion)


@rutas.get("/preferencias/mia")
def obtener_preferencia():
    return preferencias.obtener_mia(usuario_actual())


@rutas.put("/preferencias/mia")
def guardar_preferencia():
    return preferencias.guardar_mia(usuario_actual(), cuerpo_json(request))


@rutas.get("/configuracion-alertas")
def obtener_configuracion():
    return configuracion.obtener()


@rutas.put("/configuracion-alertas")
def guardar_configuracion():
    return configuracion.guardar(cuerpo_json(request))
