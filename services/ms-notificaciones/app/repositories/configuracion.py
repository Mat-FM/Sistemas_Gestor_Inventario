"""SQL de la tabla configuracion (un solo registro, id_configuracion = 1)."""

_COLUMNAS = "dias_anticipacion_vencimiento, hora_revision_diaria"


def obtener(con):
    return con.execute(f"SELECT {_COLUMNAS} FROM configuracion WHERE id_configuracion = 1").fetchone()


def guardar(con, dias_anticipacion_vencimiento, hora_revision_diaria):
    return con.execute(
        f"""UPDATE configuracion
               SET dias_anticipacion_vencimiento = %s, hora_revision_diaria = %s
             WHERE id_configuracion = 1
            RETURNING {_COLUMNAS}""",
        (dias_anticipacion_vencimiento, hora_revision_diaria),
    ).fetchone()
