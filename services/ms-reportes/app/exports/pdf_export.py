"""Exportación a PDF con fpdf2 (RF16): una hoja A4 horizontal con el título, los filtros y una o varias tablas.

Usa la fuente Helvetica que trae el PDF, que admite tildes y eñes (Latin-1); cualquier otro carácter se reemplaza
por «?» para que el archivo siempre se pueda generar.
"""

from dataclasses import dataclass
from datetime import datetime

from fpdf import FPDF


@dataclass
class Seccion:
    titulo: str | None
    columnas: list[tuple[str, str]]  # [(clave, título)]
    filas: list[dict]


def generar(titulo: str, filtros: list[str], secciones: list[Seccion], pie: str | None = None,
            tamano_letra: int = 9) -> bytes:
    pdf = FPDF(orientation="L", format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 9, _texto(titulo), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", size=8)
    pdf.cell(0, 5, _texto(f"Generado el {datetime.now():%Y-%m-%d %H:%M}"), new_x="LMARGIN", new_y="NEXT")
    for filtro in filtros:
        pdf.cell(0, 5, _texto(filtro), new_x="LMARGIN", new_y="NEXT")

    for seccion in secciones:
        pdf.ln(3)
        if seccion.titulo:
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 7, _texto(seccion.titulo), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", size=tamano_letra)
        if not seccion.filas:
            pdf.cell(0, 6, "Sin datos.", new_x="LMARGIN", new_y="NEXT")
            continue
        with pdf.table(first_row_as_headings=True) as tabla:
            encabezado = tabla.row()
            for _, nombre in seccion.columnas:
                encabezado.cell(_texto(nombre))
            for fila in seccion.filas:
                renglon = tabla.row()
                for clave, _ in seccion.columnas:
                    renglon.cell(_texto(valor_como_texto(fila.get(clave))))

    if pie:
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, _texto(pie), new_x="LMARGIN", new_y="NEXT")

    return bytes(pdf.output())


def valor_como_texto(valor) -> str:
    """Números con separador de miles y coma decimal (1.500,50), como se escriben en Colombia."""
    if valor is None:
        return ""
    if isinstance(valor, float):
        return f"{valor:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return str(valor)


def _texto(texto: str) -> str:
    return texto.encode("latin-1", "replace").decode("latin-1")
