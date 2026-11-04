<?php

/*
 * Mensajes de validación en español, escritos a mano y solo para las reglas que usa el Gateway (sin paquetes de
 * traducción, RNF15). Si una ruta nueva usa otra regla, hay que agregar aquí su mensaje: sin él Laravel
 * devolvería la clave cruda (`validation.<regla>`).
 *
 * `max` y `min` llevan un mensaje por tipo de valor: el que corresponde lo decide Laravel según las demás reglas
 * del campo (`integer` → numeric, `array` → array, un archivo subido → file, cualquier otro → string).
 */

return [
    'different' => 'El campo :attribute y :other deben ser distintos.',
    'email' => 'El campo :attribute debe ser un correo electrónico válido.',
    'in' => 'El campo :attribute tiene un valor no válido.',
    'integer' => 'El campo :attribute debe ser un número entero.',
    'max' => [
        'array' => 'El campo :attribute no puede tener más de :max elementos.',
        'file' => 'El archivo :attribute no puede superar los :max kilobytes.',
        'numeric' => 'El campo :attribute no puede ser mayor que :max.',
        'string' => 'El campo :attribute no puede tener más de :max caracteres.',
    ],
    'min' => [
        'array' => 'El campo :attribute debe tener al menos :min elementos.',
        'file' => 'El archivo :attribute debe pesar al menos :min kilobytes.',
        'numeric' => 'El campo :attribute debe ser al menos :min.',
        'string' => 'El campo :attribute debe tener al menos :min caracteres.',
    ],
    'required' => 'El campo :attribute es obligatorio.',
    'string' => 'El campo :attribute debe ser texto.',

    /*
     * Cómo se nombra cada campo dentro de los mensajes. Los que no están aquí salen con su nombre tal cual
     * (guion bajo cambiado por espacio): `nombre`, `correo`, `activo`, `pagina`. Los nombres de los campos del
     * contrato (`id_rol`, `por_pagina`...) se dejan idénticos a como los escribe el cliente, y las contraseñas
     * llevan eñe porque son texto para personas.
     */
    'attributes' => [
        'contrasena' => 'contraseña',
        'contrasena_actual' => 'contraseña actual',
        'contrasena_nueva' => 'contraseña nueva',
        'contrasena_temporal' => 'contraseña temporal',
        'id_bodega' => 'id_bodega',
        'id_rol' => 'id_rol',
        'por_pagina' => 'por_pagina',
    ],
];
