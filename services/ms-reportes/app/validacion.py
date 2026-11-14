"""Lectura y validación de parámetros. Los mensajes son los mismos que en ms-catalogo y ms-proveedores.

Cada función agrega a `errores` un {campo, mensaje} si el valor no es válido, para responder todos los errores
juntos en un solo 422 (ver `exigir_sin_errores`).
"""

from app.errores import ApiError


def entero(valor: str | None, campo: str, errores: list[dict], minimo: int | None = None,
           maximo: int | None = None) -> int | None:
    """Convierte el texto a entero. None si no llegó o si no es válido."""
    if valor is None or valor == "":
        return None
    try:
        numero = int(valor)
    except ValueError:
        errores.append({"campo": campo, "mensaje": f"El campo {campo} debe ser un número entero."})
        return None
    if minimo is not None and numero < minimo:
        errores.append({"campo": campo, "mensaje": f"El campo {campo} debe ser al menos {minimo}."})
        return None
    if maximo is not None and numero > maximo:
        errores.append({"campo": campo, "mensaje": f"El campo {campo} no puede ser mayor que {maximo}."})
        return None
    return numero


def exigir_sin_errores(errores: list[dict]) -> None:
    """422 DATOS_NO_VALIDOS con todos los errores, si hay alguno."""
    if errores:
        raise ApiError.datos_no_validos(errores)
