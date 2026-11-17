"""Error con la forma común de todos los servicios: {"error": {"codigo", "mensaje", "detalles"}}
(Entrega 2, sección 4.1)."""


class ApiError(Exception):
    def __init__(self, status, codigo, mensaje, detalles=None):
        super().__init__(mensaje)
        self.status = status
        self.codigo = codigo
        self.mensaje = mensaje
        self.detalles = detalles or []

    def a_json(self):
        return {"error": {"codigo": self.codigo, "mensaje": self.mensaje, "detalles": self.detalles}}

    @classmethod
    def peticion_invalida(cls, mensaje, detalles=None):
        return cls(400, "PETICION_INVALIDA", mensaje, detalles)

    @classmethod
    def no_autenticado(cls, mensaje):
        return cls(401, "NO_AUTENTICADO", mensaje)

    @classmethod
    def no_encontrado(cls, mensaje, codigo="NO_ENCONTRADO"):
        return cls(404, codigo, mensaje)

    @classmethod
    def datos_invalidos(cls, detalles, mensaje="Los datos enviados no son válidos."):
        return cls(422, "DATOS_INVALIDOS", mensaje, detalles)
