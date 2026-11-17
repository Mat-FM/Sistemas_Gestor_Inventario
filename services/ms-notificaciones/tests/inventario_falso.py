"""ms-inventario falso para las pruebas: responde GET /lotes y GET /saldos/bajo-umbral con el contrato
de la Tabla 9. Usa http.server de la biblioteca estándar y corre en un hilo."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class Estado:
    def __init__(self):
        self.reiniciar()

    def reiniciar(self):
        self.lotes = []
        self.bajo_umbral = []
        self.modo = "ok"  # ok | error500 | lento | no_json
        self.demora_s = 0
        self.peticiones = []


def crear(estado):
    class Manejador(BaseHTTPRequestHandler):
        def log_message(self, *_argumentos):  # Sin ruido en la salida de pytest.
            pass

        def _responder(self, status, cuerpo):
            texto = cuerpo if isinstance(cuerpo, bytes) else json.dumps(cuerpo).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(texto)))
            self.end_headers()
            self.wfile.write(texto)

        def do_GET(self):
            url = urlparse(self.path)
            consulta = {k: v[0] for k, v in parse_qs(url.query).items()}
            estado.peticiones.append({"ruta": url.path, "consulta": consulta, "request_id": self.headers.get("X-Request-Id")})
            if estado.modo == "lento":
                time.sleep(estado.demora_s)
            if estado.modo == "error500":
                return self._responder(500, {"error": {"codigo": "ERROR_INTERNO", "mensaje": "falla", "detalles": []}})
            if estado.modo == "no_json":
                return self._responder(200, b"<html>no es json</html>")

            if url.path == "/lotes":
                limite = consulta.get("vence_antes_de", "9999-12-31")
                # Como en ms-inventario: el filtro es estricto, con existencia y del que vence primero al último.
                lotes = [
                    l
                    for l in estado.lotes
                    if l["fecha_vencimiento"] and l["fecha_vencimiento"] < limite
                    and (consulta.get("con_existencia") != "true" or l.get("cantidad_disponible", 1) > 0)
                ]
                lotes.sort(key=lambda l: (l["fecha_vencimiento"], l["id_lote"]))
                pagina, por_pagina = int(consulta.get("pagina", 1)), int(consulta.get("por_pagina", 20))
                if por_pagina > 100:
                    return self._responder(
                        422,
                        {"error": {"codigo": "DATOS_NO_VALIDOS", "mensaje": "por_pagina", "detalles": []}},
                    )
                inicio = (pagina - 1) * por_pagina
                return self._responder(
                    200,
                    {
                        "datos": lotes[inicio : inicio + por_pagina],
                        "meta": {"pagina": pagina, "por_pagina": por_pagina, "total": len(lotes)},
                    },
                )
            if url.path == "/saldos/bajo-umbral":
                return self._responder(200, estado.bajo_umbral)
            return self._responder(404, {"error": {"codigo": "RUTA_NO_ENCONTRADA", "mensaje": url.path, "detalles": []}})

    servidor = ThreadingHTTPServer(("127.0.0.1", 0), Manejador)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return servidor
