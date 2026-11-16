"""Acceso a datos de las importaciones (RNF13): la única capa que usa la sesión de la base de datos."""

from sqlalchemy import select

from app.extensions import db
from app.models import ErrorImportacion, Importacion


def guardar(importacion: Importacion, errores: list[ErrorImportacion]) -> Importacion:
    """Guarda la importación con sus errores en una sola transacción."""
    importacion.errores = errores
    db.session.add(importacion)
    db.session.commit()
    return importacion


def listar(tipo: str | None, pagina: int, por_pagina: int) -> tuple[list[Importacion], int]:
    """Una página del listado, más recientes primero, y el total."""
    consulta = select(Importacion).order_by(Importacion.id_importacion.desc())
    if tipo is not None:
        consulta = consulta.where(Importacion.tipo == tipo)
    resultado = db.paginate(consulta, page=pagina, per_page=por_pagina, error_out=False)
    return resultado.items, resultado.total


def buscar(id_importacion: int) -> Importacion | None:
    return db.session.get(Importacion, id_importacion)
