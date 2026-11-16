"""Configuración de alertas: días de anticipación para los vencimientos (RF17) y hora de la revisión diaria."""
from .. import db
from ..repositories import configuracion as repo
from ..validacion import Validador

# Se llama después de guardar para que la revisión diaria se reprograme (la conecta la app).
al_cambiar = []


def _a_json(fila):
    return {
        "dias_anticipacion_vencimiento": fila["dias_anticipacion_vencimiento"],
        "hora_revision_diaria": fila["hora_revision_diaria"].strftime("%H:%M"),
    }


def obtener():
    with db.conexion() as con:
        return _a_json(repo.obtener(con))


def guardar(datos):
    v = Validador()
    dias = v.entero_positivo(datos.get("dias_anticipacion_vencimiento"), "dias_anticipacion_vencimiento", maximo=365)
    hora = v.hora(datos.get("hora_revision_diaria"), "hora_revision_diaria")
    v.verificar()
    with db.conexion() as con:
        resultado = _a_json(repo.guardar(con, dias, hora))
    for funcion in al_cambiar:
        funcion()
    return resultado
