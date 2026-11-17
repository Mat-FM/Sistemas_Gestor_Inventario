"""Preferencia de correo de cada usuario. Guarda el rol que llega en X-User-Rol para saber a quién
enviar cada alerta (Entrega 2, sección 4.9)."""
from .. import db
from ..repositories import preferencias as repo
from ..validacion import Validador


def _a_json(fila):
    return {k: fila[k] for k in ("id_usuario", "rol", "correo", "recibir_correo")}


def obtener_mia(usuario):
    """Si el usuario aún no tiene preferencia, recibir_correo es falso."""
    with db.conexion() as con:
        fila = repo.obtener(con, usuario["id"])
    if fila is None:
        return {"id_usuario": usuario["id"], "rol": usuario["rol"], "correo": None, "recibir_correo": False}
    return _a_json(fila)


def guardar_mia(usuario, datos):
    v = Validador()
    recibir_correo = v.booleano(datos.get("recibir_correo"), "recibir_correo")
    # correo es opcional: si no viene, se conserva el que ya tenía; con null se borra.
    correo_enviado = "correo" in datos
    correo = v.correo(datos.get("correo"), "correo", opcional=True) if correo_enviado else None
    v.verificar()

    with db.conexion() as con:
        actual = repo.obtener(con, usuario["id"])
        if not correo_enviado and actual is not None:
            correo = actual["correo"]
        if recibir_correo and not correo:
            v.error("correo", "Es obligatorio para recibir las alertas por correo.")
            v.verificar()
        fila = repo.guardar(con, usuario["id"], usuario["rol"], correo, recibir_correo)
    return _a_json(fila)
