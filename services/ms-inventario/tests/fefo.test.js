const { planificarFefo } = require('../src/services/stockService');

// planificarFefo (RF17, D6): la función PURA que decide de qué lotes sale una salida sin id_lote. El motor la usa con los lotes
// que lee y bloquea loteRepository.listarParaFefo; aquí se prueba sola, con casos fijos y con propiedades sobre lotes generados.

const lote = (id, fecha, cantidad) => ({ id_lote: id, fecha_vencimiento: fecha, cantidad_disponible: cantidad });
const A = lote(1, '2027-01-31', 5);
const B = lote(2, '2027-03-31', 5);
const C = lote(3, null, 4);

// Congela en profundidad: si planificarFefo mutara su entrada (sort en sitio, restar existencias), lanzaría en modo estricto.
const congelar = (lotes) => Object.freeze(lotes.map((l) => Object.freeze({ ...l })));
// Error de programación PROPIO (no el TypeError genérico de llamar a algo que no es una función): su mensaje lo nombra.
function errorDeProgramacion(llamar) {
  let error;
  try {
    llamar();
  } catch (lanzado) {
    error = lanzado;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toMatch(/^planificarFefo: /);
}

describe('planificarFefo: casos del brief', () => {
  it('A(vence 2027-01-31, 5), B(2027-03-31, 5), C(sin fecha, 4), cantidad 7 → [{A,5},{B,2}], restante 0', () => {
    /* El primero en vencer se agota y el resto sale del siguiente; el lote sin fecha no se toca. */
    expect(planificarFefo(congelar([C, B, A]), 7)).toEqual({ asignaciones: [{ id_lote: 1, cantidad: 5 }, { id_lote: 2, cantidad: 2 }], restante: 0 });
  });

  it('cantidad 20 con 14 en lotes → restante 6', () => {
    /* Se agotan todos los lotes en orden FEFO (el sin fecha al final) y lo que falta queda para el stock sin lote. */
    expect(planificarFefo(congelar([A, B, C]), 20)).toEqual({
      asignaciones: [{ id_lote: 1, cantidad: 5 }, { id_lote: 2, cantidad: 5 }, { id_lote: 3, cantidad: 4 }], restante: 6,
    });
  });
});

describe('planificarFefo: orden y casos borde', () => {
  it('los lotes sin fecha van AL FINAL, aunque tengan el id más bajo', () => {
    /* Un lote sin fecha de vencimiento no vence: sale después de todos los que sí vencen. */
    const plan = planificarFefo(congelar([lote(1, null, 3), lote(9, '2030-12-31', 3)]), 4);
    expect(plan.asignaciones).toEqual([{ id_lote: 9, cantidad: 3 }, { id_lote: 1, cantidad: 1 }]);
  });

  it('con la MISMA fecha desempata por id_lote ascendente (también entre los sin fecha)', () => {
    /* Empates: orden total y determinista, igual que el ORDER BY de listarParaFefo. */
    const lotes = congelar([lote(8, '2027-05-01', 2), lote(4, '2027-05-01', 2), lote(7, null, 2), lote(5, null, 2)]);
    expect(planificarFefo(lotes, 8).asignaciones.map((a) => a.id_lote)).toEqual([4, 8, 5, 7]);
  });

  it('compara las fechas como texto YYYY-MM-DD: 2027-10-01 vence después que 2027-09-30 y 2026-12-31 antes que 2027-01-01', () => {
    /* La comparación lexicográfica de YYYY-MM-DD coincide con la cronológica (el mes 10 no se ordena antes que el 9). */
    const lotes = congelar([lote(1, '2027-10-01', 1), lote(2, '2027-09-30', 1), lote(3, '2027-01-01', 1), lote(4, '2026-12-31', 1)]);
    expect(planificarFefo(lotes, 4).asignaciones.map((a) => a.id_lote)).toEqual([4, 3, 2, 1]);
  });

  it('ignora los lotes sin existencia (0): no aparecen en las asignaciones ni con cantidad 0', () => {
    /* Un lote agotado sigue en la tabla (tiene historia) pero no participa. */
    const plan = planificarFefo(congelar([lote(1, '2027-01-01', 0), lote(2, '2027-02-01', 3)]), 2);
    expect(plan).toEqual({ asignaciones: [{ id_lote: 2, cantidad: 2 }], restante: 0 });
  });

  it('sin lotes (o todos en 0) → ninguna asignación y restante = cantidad', () => {
    /* Todo sale del stock sin lote. */
    expect(planificarFefo([], 5)).toEqual({ asignaciones: [], restante: 5 });
    expect(planificarFefo(congelar([lote(1, null, 0)]), 5)).toEqual({ asignaciones: [], restante: 5 });
  });

  it('cantidad exactamente igual a todo lo que hay en lotes → los agota y restante 0', () => {
    /* El borde entre «alcanza» y «falta». */
    expect(planificarFefo(congelar([A, B, C]), 14)).toEqual({
      asignaciones: [{ id_lote: 1, cantidad: 5 }, { id_lote: 2, cantidad: 5 }, { id_lote: 3, cantidad: 4 }], restante: 0,
    });
  });

  it('se detiene en cuanto cubre la cantidad: no asigna del lote siguiente', () => {
    /* Con 5 exactos del primero no se toca el segundo. */
    expect(planificarFefo(congelar([A, B]), 5).asignaciones).toEqual([{ id_lote: 1, cantidad: 5 }]);
  });

  it('no muta su entrada: ni el orden del arreglo ni las existencias', () => {
    /* El motor reutiliza la lista leída; un sort en sitio la desordenaría. Además de congelada, se compara el contenido. */
    const lotes = [C, B, A].map((l) => ({ ...l }));
    const copia = JSON.parse(JSON.stringify(lotes));
    planificarFefo(lotes, 7);
    expect(lotes).toEqual(copia);
  });

  describe('errores de programación (TypeError)', () => {
    it.each([[0], [-1], [1.5], ['3'], [null], [undefined], [Number.MAX_SAFE_INTEGER + 1], [NaN], [Infinity]])('cantidad %p', (cantidad) => {
      /* La cantidad llega validada (entero positivo): otra cosa es un fallo del llamador. */
      errorDeProgramacion(() => planificarFefo([A], cantidad));
    });

    it.each([
      ['lotes no es un arreglo', null],
      ['un lote con la fecha como Date (sin el parser de Ruling 15)', [{ ...A, fecha_vencimiento: new Date('2027-01-31') }]],
      ['un lote con la fecha en otro formato', [{ ...A, fecha_vencimiento: '2027-1-31' }]],
      ['un lote con la existencia como texto', [{ ...A, cantidad_disponible: '5' }]],
      ['un lote con existencia negativa', [{ ...A, cantidad_disponible: -1 }]],
      ['un lote sin id', [{ ...A, id_lote: undefined }]],
      ['el MISMO id_lote dos veces (asignaría dos veces la misma existencia)', [A, { ...A }]],
    ])('%s', (_caso, lotes) => {
      /* Un Date compararía objetos y no días; un id repetido asignaría más de lo que hay. Mejor un 500 que un plan inventado. */
      errorDeProgramacion(() => planificarFefo(lotes, 1));
    });
  });
});

describe('planificarFefo: propiedades sobre lotes generados', () => {
  // Generador determinista (LCG): la misma semilla da los mismos casos en cada corrida, así que un fallo se reproduce.
  function generador(semilla) {
    let estado = semilla >>> 0;
    return (n) => {
      estado = (Math.imul(estado, 1664525) + 1013904223) >>> 0;
      return estado % n;
    };
  }
  const FECHAS = [null, '2026-01-31', '2027-01-31', '2027-01-31', '2027-02-28', '2027-10-01', '2027-09-30', '2028-02-29'];

  // Orden de referencia escrito aparte (no reutiliza el comparador de stockService): clave [sin fecha, fecha, id].
  const claveFefo = (l) => [l.fecha_vencimiento === null ? 1 : 0, l.fecha_vencimiento ?? '', l.id_lote];
  const antes = (a, b) => {
    const [x, y] = [claveFefo(a), claveFefo(b)];
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  };

  const CASOS = Array.from({ length: 400 }, (_, i) => {
    const azar = generador(i + 1);
    const ids = new Set();
    const lotes = Array.from({ length: azar(8) }, () => {
      let id;
      do id = 1 + azar(50); while (ids.has(id));
      ids.add(id);
      return lote(id, FECHAS[azar(FECHAS.length)], azar(4) === 0 ? 0 : azar(10));
    });
    return { lotes: congelar(lotes), cantidad: 1 + azar(40), azar };
  });

  it('400 casos: la suma de las asignaciones más restante es la cantidad; ninguna asignación supera ni iguala en 0 la existencia del lote', () => {
    /* Conservación: no se inventa ni se pierde mercancía. */
    for (const { lotes, cantidad } of CASOS) {
      const { asignaciones, restante } = planificarFefo(lotes, cantidad);
      const existencia = new Map(lotes.map((l) => [l.id_lote, l.cantidad_disponible]));
      expect(asignaciones.reduce((s, a) => s + a.cantidad, 0) + restante).toBe(cantidad);
      expect(restante).toBeGreaterThanOrEqual(0);
      for (const a of asignaciones) {
        expect(a.cantidad).toBeGreaterThan(0);
        expect(a.cantidad).toBeLessThanOrEqual(existencia.get(a.id_lote));
      }
      expect(new Set(asignaciones.map((a) => a.id_lote)).size).toBe(asignaciones.length);
    }
  });

  it('400 casos: las asignaciones siguen el orden FEFO y es un prefijo voraz (todas completas salvo, quizá, la última; y si sobra restante, se agotaron todos)', () => {
    /* Ningún lote que vence después se toca mientras uno que vence antes tenga existencia. */
    for (const { lotes, cantidad } of CASOS) {
      const { asignaciones, restante } = planificarFefo(lotes, cantidad);
      const porId = new Map(lotes.map((l) => [l.id_lote, l]));
      const conExistencia = [...lotes].filter((l) => l.cantidad_disponible > 0).sort((a, b) => (antes(a, b) ? -1 : 1));
      expect(asignaciones.map((a) => a.id_lote)).toEqual(conExistencia.slice(0, asignaciones.length).map((l) => l.id_lote));
      asignaciones.slice(0, -1).forEach((a) => expect(a.cantidad).toBe(porId.get(a.id_lote).cantidad_disponible));
      if (restante > 0) expect(asignaciones).toHaveLength(conExistencia.length);
    }
  });

  it('400 casos: el resultado no depende del orden de la entrada (orden total estable)', () => {
    /* Barajar los lotes no cambia el plan: el desempate por id_lote lo hace determinista. */
    for (const { lotes, cantidad, azar } of CASOS) {
      const barajados = [...lotes];
      for (let i = barajados.length - 1; i > 0; i -= 1) {
        const j = azar(i + 1);
        [barajados[i], barajados[j]] = [barajados[j], barajados[i]];
      }
      expect(planificarFefo(barajados, cantidad)).toEqual(planificarFefo(lotes, cantidad));
    }
  });
});
