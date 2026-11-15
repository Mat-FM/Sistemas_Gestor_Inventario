"""Reportes e indicadores de la Tabla 12 de la Entrega 2 (RF11, RF14, RF15). Validan la petición y arman la
respuesta; los cálculos están en reporte_service.

Los reportes admiten ?formato=json (por defecto), csv o pdf; con csv o pdf la respuesta es un archivo para descargar.
"""

import io
from datetime import date

from flask import Blueprint, jsonify, request, send_file

from app.exports import csv_export, pdf_export
from app.exports.pdf_export import Seccion
from app.services import reporte_service as reportes
from app.validacion import entero, exigir_sin_errores, fecha, opcion

bp = Blueprint("reportes", __name__)

FORMATOS = ("json", "csv", "pdf")
TIPOS_MOVIMIENTO = ("ENTRADA", "SALIDA", "AJUSTE", "DEVOLUCION_CLIENTE", "ENTRADA_COMPRA", "DEVOLUCION_PROVEEDOR",
                    "TRASLADO_SALIDA", "TRASLADO_ENTRADA", "CARGA_INICIAL")

# Columnas de cada archivo: (clave del JSON, título).
COLUMNAS_EXISTENCIAS = [("codigo", "Código"), ("nombre", "Producto"), ("bodega", "Bodega"),
                        ("cantidad_disponible", "Cantidad disponible")]
COLUMNAS_VALORIZACION = [("codigo", "Código"), ("nombre", "Producto"), ("cantidad", "Cantidad"),
                         ("precio", "Precio"), ("valor", "Valor")]
COLUMNAS_ROTACION = [("codigo", "Código"), ("nombre", "Producto"), ("salidas", "Salidas")]
COLUMNAS_KARDEX = [("fecha", "Fecha"), ("tipo", "Tipo"), ("codigo", "Código"), ("nombre", "Producto"),
                   ("bodega", "Bodega"), ("cantidad", "Cantidad"), ("saldo_resultante", "Saldo"),
                   ("id_usuario", "Usuario"), ("documento_referencia", "Documento"), ("observacion", "Observación")]


@bp.get("/reportes/existencias")
def existencias():
    """?id_bodega&id_categoria&formato"""
    errores = []
    id_bodega = entero(request.args.get("id_bodega"), "id_bodega", errores, minimo=1)
    id_categoria = entero(request.args.get("id_categoria"), "id_categoria", errores, minimo=1)
    formato = _formato(errores)
    exigir_sin_errores(errores)

    filas = reportes.existencias(id_bodega, id_categoria)
    if formato == "json":
        return jsonify(filas)
    return _archivo(formato, "existencias", "Reporte de existencias",
                    [Seccion(None, COLUMNAS_EXISTENCIAS, filas)], COLUMNAS_EXISTENCIAS, filas)


@bp.get("/reportes/valorizacion")
def valorizacion():
    """?id_bodega&formato"""
    errores = []
    id_bodega = entero(request.args.get("id_bodega"), "id_bodega", errores, minimo=1)
    formato = _formato(errores)
    exigir_sin_errores(errores)

    resultado = reportes.valorizacion(id_bodega)
    if formato == "json":
        return jsonify(resultado)
    # En el CSV, el total va como una última fila.
    filas_csv = resultado["productos"] + [{"nombre": "Valor total", "valor": resultado["valor_total"]}]
    return _archivo(formato, "valorizacion", "Valorización del inventario",
                    [Seccion(None, COLUMNAS_VALORIZACION, resultado["productos"])], COLUMNAS_VALORIZACION, filas_csv,
                    pie=f"Valor total: {pdf_export.valor_como_texto(float(resultado['valor_total']))}")


@bp.get("/reportes/rotacion")
def rotacion():
    """?fecha_desde&fecha_hasta (obligatorios)&limite&formato"""
    errores = []
    desde = fecha(request.args.get("fecha_desde"), "fecha_desde", errores)
    hasta = fecha(request.args.get("fecha_hasta"), "fecha_hasta", errores)
    for campo, valor in (("fecha_desde", desde), ("fecha_hasta", hasta)):
        if not request.args.get(campo):
            errores.append({"campo": campo, "mensaje": f"El campo {campo} es obligatorio."})
    limite = entero(request.args.get("limite"), "limite", errores, minimo=1, maximo=100)
    formato = _formato(errores)
    exigir_sin_errores(errores)
    reportes.validar_rango(desde, hasta)

    resultado = reportes.rotacion(desde, hasta, limite or reportes.LIMITE_ROTACION)
    if formato == "json":
        return jsonify(resultado)
    # En el CSV, las dos listas van seguidas, con una columna que dice a cuál pertenece cada fila.
    columnas_csv = [("lista", "Lista")] + COLUMNAS_ROTACION
    filas_csv = ([{"lista": "Mayor rotación"} | f for f in resultado["mayor_rotacion"]]
                 + [{"lista": "Menor rotación"} | f for f in resultado["menor_rotacion"]])
    return _archivo(formato, "rotacion", "Rotación de productos",
                    [Seccion("Mayor rotación", COLUMNAS_ROTACION, resultado["mayor_rotacion"]),
                     Seccion("Menor rotación", COLUMNAS_ROTACION, resultado["menor_rotacion"])],
                    columnas_csv, filas_csv)


@bp.get("/reportes/kardex")
def kardex():
    """Los filtros de GET /movimientos (?id_producto&id_bodega&id_usuario&tipo&fecha_desde&fecha_hasta) y formato."""
    errores = []
    filtros = {
        "id_producto": entero(request.args.get("id_producto"), "id_producto", errores, minimo=1),
        "id_bodega": entero(request.args.get("id_bodega"), "id_bodega", errores, minimo=1),
        "id_usuario": entero(request.args.get("id_usuario"), "id_usuario", errores, minimo=1),
        "tipo": opcion(request.args.get("tipo"), "tipo", errores, TIPOS_MOVIMIENTO),
    }
    desde = fecha(request.args.get("fecha_desde"), "fecha_desde", errores)
    hasta = fecha(request.args.get("fecha_hasta"), "fecha_hasta", errores)
    formato = _formato(errores)
    exigir_sin_errores(errores)
    if desde and hasta:
        reportes.validar_rango(desde, hasta)
    filtros["fecha_desde"] = desde.isoformat() if desde else None
    filtros["fecha_hasta"] = hasta.isoformat() if hasta else None

    filas = reportes.kardex(filtros)
    if formato == "json":
        return jsonify(filas)
    return _archivo(formato, "kardex", "Kardex", [Seccion(None, COLUMNAS_KARDEX, filas)], COLUMNAS_KARDEX, filas,
                    tamano_letra=7)


@bp.get("/indicadores")
def indicadores():
    """?fecha_desde&fecha_hasta (opcionales). Solo JSON: es el panel del cliente web."""
    errores = []
    desde = fecha(request.args.get("fecha_desde"), "fecha_desde", errores)
    hasta = fecha(request.args.get("fecha_hasta"), "fecha_hasta", errores)
    exigir_sin_errores(errores)

    return jsonify(reportes.indicadores(desde, hasta))


def _formato(errores: list[dict]) -> str:
    return opcion(request.args.get("formato"), "formato", errores, FORMATOS) or "json"


def _archivo(formato: str, nombre: str, titulo: str, secciones: list[Seccion], columnas_csv: list[tuple[str, str]],
             filas_csv: list[dict], pie: str | None = None, tamano_letra: int = 9):
    """El reporte como archivo para descargar, por ejemplo kardex-2026-11-14.pdf."""
    if formato == "csv":
        contenido, tipo = csv_export.generar(columnas_csv, filas_csv), "text/csv"
    else:
        # En el PDF se anotan los filtros usados, para saber de qué es el reporte al imprimirlo.
        filtros = [f"{clave}: {valor}" for clave, valor in request.args.items() if clave != "formato" and valor]
        contenido = pdf_export.generar(titulo, filtros, secciones, pie, tamano_letra)
        tipo = "application/pdf"
    return send_file(io.BytesIO(contenido), mimetype=tipo, as_attachment=True,
                     download_name=f"{nombre}-{date.today().isoformat()}.{formato}")
