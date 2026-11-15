"""Operaciones de importación de la Tabla 12 de la Entrega 2 (RF16). Validan la petición y arman la respuesta;
las reglas de negocio están en importacion_service."""

import ntpath
from datetime import UTC, datetime

from flask import Blueprint, jsonify, request

from app.errores import ApiError
from app.models import TIPOS, Importacion
from app.paginacion import leer_paginacion, respuesta_paginada
from app.services import importacion_service
from app.validacion import exigir_sin_errores

bp = Blueprint("importaciones", __name__)


@bp.post("/importaciones")
def crear():
    """multipart/form-data con `archivo` (CSV o .xlsx) y `tipo` (PRODUCTOS, PROVEEDORES o STOCK_INICIAL)."""
    id_usuario = _usuario()

    errores = []
    tipo = request.form.get("tipo", "").strip()
    if tipo == "":
        errores.append({"campo": "tipo", "mensaje": "El campo tipo es obligatorio."})
    elif tipo not in TIPOS:
        errores.append({"campo": "tipo", "mensaje": "El campo tipo tiene un valor no válido."})
    archivo = request.files.get("archivo")
    if archivo is None or not archivo.filename:
        errores.append({"campo": "archivo", "mensaje": "El campo archivo es obligatorio."})
    exigir_sin_errores(errores)

    # Solo el nombre, sin la ruta que algunos navegadores envían (por ejemplo C:\Users\...\productos.csv).
    nombre = ntpath.basename(archivo.filename)
    importacion = importacion_service.importar(tipo, nombre, archivo.read(), id_usuario)
    return jsonify(_detalle(importacion)), 201


@bp.get("/importaciones")
def listar():
    """?tipo&pagina&por_pagina, más recientes primero."""
    errores = []
    tipo = request.args.get("tipo") or None
    if tipo is not None and tipo not in TIPOS:
        errores.append({"campo": "tipo", "mensaje": "El campo tipo tiene un valor no válido."})
    pagina, por_pagina = leer_paginacion(errores)
    exigir_sin_errores(errores)

    elementos, total = importacion_service.listar(tipo, pagina, por_pagina)
    return jsonify(respuesta_paginada(elementos, total, pagina, por_pagina, _formato))


@bp.get("/importaciones/<int:id_importacion>")
def consultar(id_importacion: int):
    """La importación con sus errores por fila. Un id no numérico responde 404."""
    return jsonify(_detalle(importacion_service.buscar(id_importacion)))


def _usuario() -> int:
    """Usuario que envía el Gateway. Solo el administrador usa esta ruta, siempre a través del Gateway."""
    valor = request.headers.get("X-User-Id", "")
    if not valor.isdigit() or int(valor) < 1:
        raise ApiError.peticion_mal_formada(400, "Falta la cabecera X-User-Id o no es válida.")
    return int(valor)


def _formato(i: Importacion) -> dict:
    return {
        "id_importacion": i.id_importacion,
        "tipo": i.tipo,
        "nombre_archivo": i.nombre_archivo,
        "estado": i.estado,
        "filas_totales": i.filas_totales,
        "filas_validas": i.filas_validas,
        "filas_con_error": i.filas_con_error,
        "id_usuario": i.id_usuario,
        "fecha": _fecha_utc(i.fecha),
    }


def _detalle(i: Importacion) -> dict:
    """Con los errores ordenados por fila. numero_fila 0 es un error de toda la importación."""
    return _formato(i) | {
        "errores": [{"numero_fila": e.numero_fila, "campo": e.campo, "mensaje": e.mensaje} for e in i.errores],
    }


def _fecha_utc(fecha: datetime) -> str:
    """ISO 8601 en UTC, como 2026-11-14T19:09:40Z. SQLite (pruebas) devuelve la fecha sin zona: ya está en UTC."""
    if fecha.tzinfo is None:
        fecha = fecha.replace(tzinfo=UTC)
    return fecha.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
