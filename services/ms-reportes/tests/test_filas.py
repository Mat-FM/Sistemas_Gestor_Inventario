"""Conversión de los números de un archivo de importación (precio y cantidad)."""

import pytest

from app.importers.filas import validar

PRODUCTO = {"codigo": "P-1", "nombre": "Agua", "descripcion": "", "categoria": "Bebidas", "unidad_medida": "UNIDAD"}


def precio(texto: str):
    datos, errores = validar("PRODUCTOS", PRODUCTO | {"precio": texto})
    return datos["precio"], errores


@pytest.mark.parametrize("texto, esperado", [
    ("2500", 2500),
    ("2500.5", 2500.5),
    ("2500,5", 2500.5),                # coma decimal, como en Excel en español
    ("2.500,50", 2500.5),              # punto de miles y coma decimal
    ("2,500.50", 2500.5),              # coma de miles y punto decimal
    ("1.234.567,89", 1234567.89),
    ("1,234,567.89", 1234567.89),
    ("1.234.567", 1234567),            # varios puntos: solo pueden ser miles
    ("1,234,567", 1234567),
])
def test_acepta_los_formatos_de_numero_de_excel_y_de_texto(texto, esperado):
    valor, errores = precio(texto)

    assert errores == []
    assert valor == esperado


@pytest.mark.parametrize("texto", [
    "1.2.3",          # puntos sin forma de miles
    "1,2,3",
    "1.5000,5",       # un grupo de miles con más de tres cifras
    "12.34,56.78",    # dos separadores decimales
    "2.500,5,0",
    "abc",
    "1e999",
    "",
])
def test_rechaza_los_numeros_con_una_forma_imposible(texto):
    _, errores = precio(texto)

    assert [e["campo"] for e in errores] == ["precio"]
