"""SQL de la tabla preferencia (una por usuario)."""

_COLUMNAS = "id_preferencia, id_usuario, rol, correo, recibir_correo"


def obtener(con, id_usuario):
    return con.execute(f"SELECT {_COLUMNAS} FROM preferencia WHERE id_usuario = %s", (id_usuario,)).fetchone()


def guardar(con, id_usuario, rol, correo, recibir_correo):
    """Crea o actualiza la preferencia del usuario; guarda también su rol actual."""
    return con.execute(
        f"""INSERT INTO preferencia (id_usuario, rol, correo, recibir_correo)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (id_usuario) DO UPDATE
               SET rol = EXCLUDED.rol, correo = EXCLUDED.correo, recibir_correo = EXCLUDED.recibir_correo
            RETURNING {_COLUMNAS}""",
        (id_usuario, rol, correo, recibir_correo),
    ).fetchone()


def correos_del_rol(con, rol):
    """Correos de los usuarios del rol que pidieron recibir las alertas por ese medio."""
    filas = con.execute(
        "SELECT correo FROM preferencia WHERE rol = %s AND recibir_correo ORDER BY id_usuario", (rol,)
    ).fetchall()
    return [fila["correo"] for fila in filas]
