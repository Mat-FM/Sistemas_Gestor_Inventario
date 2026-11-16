"""Reglas de las notificaciones: crear sin duplicar, listar por rol, marcar como leída y avisar por correo."""
import threading

from .. import db, logger
from ..clients import correo
from ..contexto import ROLES
from ..errores import ApiError
from ..repositories import notificaciones as repo
from ..repositories import preferencias as repo_preferencias
from ..validacion import Validador, booleano_de_consulta, paginacion

TIPOS = ("STOCK_BAJO", "VENCIMIENTO", "ORDEN_RECIBIDA")
ASUNTOS = {
    "STOCK_BAJO": "Producto bajo el stock mínimo",
    "VENCIMIENTO": "Lote próximo a vencer",
    "ORDEN_RECIBIDA": "Orden de compra recibida",
}


def _a_json(fila):
    return {**fila, "fecha": fila["fecha"].isoformat().replace("+00:00", "Z")}


def _en_segundo_plano(funcion, *argumentos):
    """El correo no debe demorar la respuesta. Las pruebas lo reemplazan para que corra en línea."""
    threading.Thread(target=funcion, args=argumentos, daemon=True).start()


def validar_entrada(datos):
    v = Validador()
    entrada = {
        "tipo": v.opcion(datos.get("tipo"), "tipo", TIPOS),
        "mensaje": v.texto(datos.get("mensaje"), "mensaje", maximo=500),
        "id_producto": v.entero_positivo(datos.get("id_producto"), "id_producto", opcional=True),
        "id_bodega": v.entero_positivo(datos.get("id_bodega"), "id_bodega", opcional=True),
        "rol_destinatario": v.opcion(datos.get("rol_destinatario"), "rol_destinatario", ROLES, opcional=True)
        or "ADMINISTRADOR",
    }
    v.verificar()
    return entrada


def crear(entrada, request_id):
    """Guarda la alerta y, si es nueva, la envía por correo en segundo plano.

    Devuelve (notificacion, creada). Si ya había una igual sin leer, devuelve (None, False).
    """
    with db.conexion() as con:
        fila = repo.crear(con, **entrada)
    if fila is None:
        logger.info(
            "alerta repetida",
            request_id=request_id,
            tipo=entrada["tipo"],
            id_producto=entrada["id_producto"],
            rol=entrada["rol_destinatario"],
        )
        return None, False
    logger.info("alerta creada", request_id=request_id, id_notificacion=fila["id_notificacion"], tipo=fila["tipo"])
    if correo.configurado():
        _en_segundo_plano(enviar_por_correo, fila, request_id)
    return _a_json(fila), True


def enviar_por_correo(notificacion, request_id=None):
    """Envía la alerta a los usuarios del rol que activaron recibir_correo (llamada 9).
    Si el envío falla, la alerta sigue visible en la interfaz y correo_enviado queda en falso."""
    try:
        with db.conexion() as con:
            destinatarios = repo_preferencias.correos_del_rol(con, notificacion["rol_destinatario"])
        if not destinatarios:
            return False
        if not correo.enviar(destinatarios, ASUNTOS[notificacion["tipo"]], notificacion["mensaje"]):
            return False
        with db.conexion() as con:
            repo.marcar_correo_enviado(con, notificacion["id_notificacion"])
        logger.info("correo enviado", request_id=request_id, id_notificacion=notificacion["id_notificacion"])
        return True
    except Exception as error:  # Un hilo en segundo plano nunca debe morir en silencio.
        logger.error("fallo al enviar el correo", request_id=request_id, error=str(error))
        return False


def listar(usuario, consulta):
    """Cada usuario ve solo las notificaciones dirigidas a su rol (RF09, RF17)."""
    v = Validador()
    leida = booleano_de_consulta(v, consulta.get("leida"), "leida")
    tipo = v.opcion(consulta.get("tipo") or None, "tipo", TIPOS, opcional=True)
    pagina, por_pagina = paginacion(v, consulta)
    v.verificar()
    with db.conexion() as con:
        filas, total = repo.listar(con, usuario["rol"], leida, tipo, pagina, por_pagina)
    return {
        "datos": [_a_json(f) for f in filas],
        "meta": {"pagina": pagina, "por_pagina": por_pagina, "total": total},
    }


def marcar_leida(usuario, id_notificacion):
    with db.conexion() as con:
        fila = repo.marcar_leida(con, id_notificacion, usuario["rol"])
    if fila is None:
        raise ApiError.no_encontrado("La notificación no existe o no está dirigida a su rol.")
    return _a_json(fila)
