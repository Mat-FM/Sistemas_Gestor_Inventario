"""Validación sencilla de los datos de entrada. Acumula los errores por campo para devolverlos
todos juntos en un 422 (Entrega 2, sección 4.1)."""
import re

from .errores import ApiError

_CORREO = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_HORA = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class Validador:
    def __init__(self):
        self.detalles = []

    def error(self, campo, mensaje):
        self.detalles.append({"campo": campo, "mensaje": mensaje})

    def entero_positivo(self, valor, campo, opcional=False, maximo=None):
        if valor is None:
            if not opcional:
                self.error(campo, "Es obligatorio.")
            return None
        # bool es subclase de int en Python: true no es un número válido.
        if isinstance(valor, bool) or not isinstance(valor, int) or valor <= 0:
            self.error(campo, "Debe ser un número entero mayor que cero.")
            return None
        if maximo is not None and valor > maximo:
            self.error(campo, f"No puede ser mayor que {maximo}.")
            return None
        return valor

    def texto(self, valor, campo, opcional=False, maximo=255):
        if valor is None or (isinstance(valor, str) and valor.strip() == ""):
            if not opcional:
                self.error(campo, "Es obligatorio.")
            return None
        if not isinstance(valor, str):
            self.error(campo, "Debe ser un texto.")
            return None
        if len(valor.strip()) > maximo:
            self.error(campo, f"No puede tener más de {maximo} caracteres.")
            return None
        return valor.strip()

    def opcion(self, valor, campo, opciones, opcional=False):
        if valor is None:
            if not opcional:
                self.error(campo, "Es obligatorio.")
            return None
        if valor not in opciones:
            self.error(campo, f"Debe ser uno de: {', '.join(opciones)}.")
            return None
        return valor

    def booleano(self, valor, campo):
        if not isinstance(valor, bool):
            self.error(campo, "Debe ser verdadero o falso.")
            return None
        return valor

    def correo(self, valor, campo, opcional=False):
        texto = self.texto(valor, campo, opcional=opcional, maximo=150)
        if texto is not None and not _CORREO.match(texto):
            self.error(campo, "No es un correo válido.")
            return None
        return texto

    def hora(self, valor, campo):
        if not isinstance(valor, str) or not _HORA.match(valor):
            self.error(campo, "Debe ser una hora con formato HH:MM (00:00 a 23:59).")
            return None
        return valor

    def verificar(self):
        """Lanza un 422 si hubo algún error."""
        if self.detalles:
            raise ApiError.datos_invalidos(self.detalles)


def cuerpo_json(request):
    """El cuerpo debe ser un objeto JSON; si no lo es, 400."""
    datos = request.get_json(silent=False) if request.data else {}
    if not isinstance(datos, dict):
        raise ApiError.peticion_invalida("El cuerpo de la petición debe ser un objeto JSON.")
    return datos


def booleano_de_consulta(validador, valor, campo):
    """Para ?leida=true|false."""
    if valor is None or valor == "":
        return None
    if valor.lower() in ("true", "1"):
        return True
    if valor.lower() in ("false", "0"):
        return False
    validador.error(campo, "Debe ser true o false.")
    return None


def paginacion(validador, consulta):
    def leer(nombre, por_defecto):
        valor = consulta.get(nombre)
        if valor is None:
            return por_defecto
        try:
            return int(valor)
        except ValueError:
            return -1

    pagina = leer("pagina", 1)
    por_pagina = leer("por_pagina", 20)
    if pagina < 1:
        validador.error("pagina", "Debe ser un entero mayor o igual a 1.")
    if por_pagina < 1 or por_pagina > 100:
        validador.error("por_pagina", "Debe ser un entero entre 1 y 100.")
    return pagina, por_pagina
