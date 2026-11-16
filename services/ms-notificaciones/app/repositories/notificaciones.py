"""SQL de la tabla notificacion."""

_COLUMNAS = """id_notificacion, tipo, mensaje, id_producto, id_bodega, rol_destinatario,
               leida, correo_enviado, fecha"""


def crear(con, tipo, mensaje, id_producto, id_bodega, rol_destinatario):
    """Devuelve la notificación creada o None si ya había una igual sin leer (índice uq_notificacion_sin_leer)."""
    return con.execute(
        f"""INSERT INTO notificacion (tipo, mensaje, id_producto, id_bodega, rol_destinatario)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (tipo, id_producto, rol_destinatario) WHERE NOT leida AND id_producto IS NOT NULL
            DO NOTHING
            RETURNING {_COLUMNAS}""",
        (tipo, mensaje, id_producto, id_bodega, rol_destinatario),
    ).fetchone()


def listar(con, rol, leida=None, tipo=None, pagina=1, por_pagina=20):
    condiciones = ["rol_destinatario = %s"]
    valores = [rol]
    if leida is not None:
        condiciones.append("leida = %s")
        valores.append(leida)
    if tipo is not None:
        condiciones.append("tipo = %s")
        valores.append(tipo)
    donde = " AND ".join(condiciones)
    total = con.execute(f"SELECT count(*) AS n FROM notificacion WHERE {donde}", valores).fetchone()["n"]
    filas = con.execute(
        f"""SELECT {_COLUMNAS} FROM notificacion WHERE {donde}
            ORDER BY fecha DESC, id_notificacion DESC
            LIMIT %s OFFSET %s""",
        [*valores, por_pagina, (pagina - 1) * por_pagina],
    ).fetchall()
    return filas, total


def marcar_leida(con, id_notificacion, rol):
    """Solo marca las del rol del usuario; devuelve None si no existe o es de otro rol."""
    return con.execute(
        f"""UPDATE notificacion SET leida = TRUE
            WHERE id_notificacion = %s AND rol_destinatario = %s
            RETURNING {_COLUMNAS}""",
        (id_notificacion, rol),
    ).fetchone()


def marcar_correo_enviado(con, id_notificacion):
    con.execute("UPDATE notificacion SET correo_enviado = TRUE WHERE id_notificacion = %s", (id_notificacion,))
