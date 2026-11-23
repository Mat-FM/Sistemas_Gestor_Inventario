// Un formulario que modifica datos (POST) se envía una sola vez: un segundo toque en «Guardar» o «Recibir», muy común en el
// celular, no manda otra petición mientras la primera está en camino.
// Los formularios con data-confirmar piden confirmación antes de enviarse (dar de baja, eliminar, restablecer).
// Va en la fase de captura para cancelar antes de que el formulario se marque como enviado.
document.addEventListener('submit', function (evento) {
  var mensaje = evento.target.dataset ? evento.target.dataset.confirmar : null;
  if (mensaje && !window.confirm(mensaje)) { evento.preventDefault(); }
}, true);

document.addEventListener('submit', function (evento) {
  if (evento.defaultPrevented) { return; }
  var formulario = evento.target;
  if (!(formulario instanceof HTMLFormElement) || formulario.method.toLowerCase() !== 'post') { return; }
  if (formulario.dataset.enviando === '1') { evento.preventDefault(); return; }
  formulario.dataset.enviando = '1';
  // Se deshabilita después de que el navegador arme el envío (un botón deshabilitado no se envía).
  setTimeout(function () {
    formulario.querySelectorAll('button:not([type=button])').forEach(function (boton) {
      boton.disabled = true;
      boton.setAttribute('aria-busy', 'true');
    });
  }, 0);
});

// Al volver con «Atrás», el formulario debe poder usarse otra vez.
window.addEventListener('pageshow', function (evento) {
  if (!evento.persisted) { return; }
  document.querySelectorAll('form[data-enviando]').forEach(function (formulario) {
    delete formulario.dataset.enviando;
    formulario.querySelectorAll('button[disabled]').forEach(function (boton) { boton.disabled = false; boton.removeAttribute('aria-busy'); });
  });
});

// «Generar»: una contraseña temporal de 10 caracteres, con letras y números, sin los que se confunden (0/O, 1/l/I).
document.addEventListener('click', function (evento) {
  var boton = evento.target.closest('[data-generar-contrasena]');
  if (!boton) { return; }
  var campo = document.querySelector(boton.dataset.generarContrasena);
  if (!campo) { return; }
  var letras = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', numeros = '23456789', todos = letras + numeros;
  var azar = function (n) { var v = new Uint32Array(1); window.crypto.getRandomValues(v); return v[0] % n; };
  var clave = [letras[azar(letras.length)], numeros[azar(numeros.length)]];
  while (clave.length < 10) { clave.push(todos[azar(todos.length)]); }
  for (var i = clave.length - 1; i > 0; i--) { var j = azar(i + 1); var t = clave[i]; clave[i] = clave[j]; clave[j] = t; }
  campo.value = clave.join('');
  campo.dispatchEvent(new Event('input', { bubbles: true }));
});

// La bodega solo se pide cuando el rol es «operador de bodega».
(function () {
  var rol = document.querySelector('[data-rol-operador]');
  var grupo = document.getElementById('grupo-bodega');
  if (!rol || !grupo) { return; }
  var actualizar = function () { grupo.hidden = rol.dataset.rolOperador === '' || rol.value !== rol.dataset.rolOperador; };
  rol.addEventListener('change', actualizar);
  actualizar();
})();

// Orden de compra: agregar y quitar líneas de producto, y proponer el precio del producto elegido.
document.addEventListener('click', function (evento) {
  var agregar = evento.target.closest('[data-agregar-linea]');
  if (agregar) {
    var contenedor = document.querySelector(agregar.dataset.agregarLinea);
    var plantilla = document.querySelector(agregar.dataset.plantilla);
    if (!contenedor || !plantilla) { return; }
    var indice = parseInt(contenedor.dataset.siguiente || '0', 10);
    contenedor.dataset.siguiente = String(indice + 1);
    contenedor.insertAdjacentHTML('beforeend', plantilla.innerHTML.split('__I__').join(String(indice)));
    return;
  }
  var quitar = evento.target.closest('[data-quitar-linea]');
  if (quitar) {
    var linea = quitar.closest('[data-linea]');
    var lineas = linea.parentElement.querySelectorAll('[data-linea]');
    if (lineas.length > 1) { linea.remove(); } else { linea.querySelectorAll('input').forEach(function (c) { c.value = ''; }); linea.querySelector('select').value = ''; }
  }
});
document.addEventListener('change', function (evento) {
  var producto = evento.target.closest('select[data-producto]');
  if (!producto) { return; }
  var precio = producto.closest('[data-linea]').querySelector('input[data-precio]');
  var elegido = producto.options[producto.selectedIndex];
  if (precio && precio.value === '' && elegido && elegido.dataset.precio) { precio.value = elegido.dataset.precio; }
});

// En el computador, «/» lleva el cursor a la búsqueda de productos (salvo que ya se esté escribiendo en otro campo).
document.addEventListener('keydown', function (evento) {
  if (evento.key !== '/' || evento.ctrlKey || evento.metaKey || evento.altKey) { return; }
  var destino = evento.target;
  if (destino && (/^(input|textarea|select)$/i.test(destino.tagName) || destino.isContentEditable)) { return; }
  var cuadro = document.getElementById('buscar-global');
  if (cuadro && cuadro.offsetParent !== null) { evento.preventDefault(); cuadro.focus(); cuadro.select(); }
});

// Los iconos son decoración: el texto de cada botón o enlace ya dice lo que hace. Así el lector de pantalla no los lee.
document.querySelectorAll('i.bi').forEach(function (icono) { icono.setAttribute('aria-hidden', 'true'); });
