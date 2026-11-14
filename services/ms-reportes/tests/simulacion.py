"""Simulación de los demás servicios para las pruebas: reemplaza requests.request, así ninguna prueba sale a la red.

Está en un módulo aparte (y no en conftest.py) para que las pruebas y conftest usen las mismas clases.
"""


class Respuesta:
    """Lo mínimo de requests.Response que usan los clientes."""

    def __init__(self, status_code: int, cuerpo=None):
        self.status_code = status_code
        self._cuerpo = cuerpo

    def json(self):
        if self._cuerpo is None:
            raise ValueError("sin JSON")
        return self._cuerpo


class ServiciosFalsos:
    """Responde según el final de la URL. Cada respuesta puede ser una Respuesta, un valor (200 con ese JSON),
    una función que recibe la llamada, o una excepción para simular un fallo de conexión."""

    def __init__(self):
        self.respuestas: dict[str, object] = {}
        self.llamadas: list[dict] = []

    def responder(self, ruta: str, respuesta) -> None:
        self.respuestas[ruta] = respuesta

    def llamadas_a(self, ruta: str) -> list[dict]:
        return [llamada for llamada in self.llamadas if llamada["url"].endswith(ruta)]

    def __call__(self, metodo, url, headers=None, timeout=None, params=None, json=None):
        llamada = {"metodo": metodo, "url": url, "headers": headers or {}, "params": params or {}, "json": json}
        self.llamadas.append(llamada)
        # La ruta más larga primero: /saldos/bajo-umbral antes que /saldos.
        for ruta in sorted(self.respuestas, key=len, reverse=True):
            if url.endswith(ruta):
                respuesta = self.respuestas[ruta]
                if isinstance(respuesta, Exception):
                    raise respuesta
                if callable(respuesta):
                    respuesta = respuesta(llamada)
                return respuesta if isinstance(respuesta, Respuesta) else Respuesta(200, respuesta)
        raise AssertionError(f"Llamada no esperada: {metodo} {url}")


def paginado(datos: list, llamada: dict) -> Respuesta:
    """Responde un listado paginado {datos, meta} con la página que se pidió."""
    pagina, por_pagina = int(llamada["params"]["pagina"]), int(llamada["params"]["por_pagina"])
    inicio = (pagina - 1) * por_pagina
    return Respuesta(200, {"datos": datos[inicio:inicio + por_pagina],
                           "meta": {"pagina": pagina, "por_pagina": por_pagina, "total": len(datos)}})


class Reloj:
    """Reloj del cortacircuitos que solo avanza cuando la prueba lo pide."""

    def __init__(self):
        self.ahora = 1000.0

    def __call__(self):
        return self.ahora
