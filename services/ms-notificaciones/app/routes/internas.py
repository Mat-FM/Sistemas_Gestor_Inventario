"""POST /internas/notificaciones: avisos de ms-inventario (STOCK_BAJO) y ms-compras (ORDEN_RECIBIDA).
El Gateway no publica esta ruta; solo la llaman otros servicios dentro del clúster."""
from flask import Blueprint, g, request

from ..services import notificaciones
from ..validacion import cuerpo_json

rutas = Blueprint("internas", __name__)


@rutas.post("/internas/notificaciones")
def recibir_aviso():
    entrada = notificaciones.validar_entrada(cuerpo_json(request))
    notificacion, creada = notificaciones.crear(entrada, g.request_id)
    # 202 también cuando ya había una igual sin leer: el aviso se aceptó, solo no se duplica.
    return {"aceptada": True, "duplicada": not creada, "notificacion": notificacion}, 202
