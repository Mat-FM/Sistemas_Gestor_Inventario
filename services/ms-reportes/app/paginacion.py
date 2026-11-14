"""Listados con la forma común de la Entrega 2 (sección 4.1):
{"datos": [...], "meta": {"pagina", "por_pagina", "total"}}, con ?pagina=1&por_pagina=20 (máximo 100).
"""

from collections.abc import Callable

from flask import request
from sqlalchemy import Select

from app.extensions import db
from app.validacion import entero

POR_PAGINA_PREDETERMINADO = 20
POR_PAGINA_MAXIMO = 100


def leer_paginacion(errores: list[dict]) -> tuple[int, int]:
    """Lee ?pagina y ?por_pagina de la petición. Los errores se agregan a `errores` (422 junto con los filtros)."""
    pagina = entero(request.args.get("pagina"), "pagina", errores, minimo=1)
    por_pagina = entero(request.args.get("por_pagina"), "por_pagina", errores, minimo=1, maximo=POR_PAGINA_MAXIMO)
    return pagina or 1, por_pagina or POR_PAGINA_PREDETERMINADO


def paginar(consulta: Select, pagina: int, por_pagina: int, formato: Callable) -> dict:
    """Ejecuta la consulta para una página y aplica `formato` a cada elemento."""
    resultado = db.paginate(consulta, page=pagina, per_page=por_pagina, error_out=False)
    return {
        "datos": [formato(elemento) for elemento in resultado.items],
        "meta": {"pagina": pagina, "por_pagina": por_pagina, "total": resultado.total},
    }
