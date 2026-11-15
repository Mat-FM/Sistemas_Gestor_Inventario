<?php

/*
 * Mensajes de validación en español, escritos a mano y solo para las reglas que usa el servicio
 * (sin paquetes de traducción, RNF15). Si se usa una regla nueva, hay que agregar aquí su mensaje:
 * sin él, Laravel devolvería la clave cruda (validation.<regla>).
 */

return [
    'array' => 'El campo :attribute debe ser una lista.',
    'boolean' => 'El campo :attribute debe ser verdadero o falso.',
    'in' => 'El campo :attribute tiene un valor no válido.',
    'integer' => 'El campo :attribute debe ser un número entero.',
    'max' => [
        'array' => 'El campo :attribute no puede tener más de :max elementos.',
        'numeric' => 'El campo :attribute no puede ser mayor que :max.',
        'string' => 'El campo :attribute no puede tener más de :max caracteres.',
    ],
    'min' => [
        'array' => 'El campo :attribute debe tener al menos :min elementos.',
        'numeric' => 'El campo :attribute debe ser al menos :min.',
        'string' => 'El campo :attribute debe tener al menos :min caracteres.',
    ],
    'numeric' => 'El campo :attribute debe ser un número.',
    'required' => 'El campo :attribute es obligatorio.',
    'string' => 'El campo :attribute debe ser texto.',

    // Se muestran con el nombre del campo del contrato, sin cambiar el guion bajo por un espacio.
    'attributes' => [
        'codigo' => 'codigo',
        'nombre' => 'nombre',
        'descripcion' => 'descripcion',
        'id_categoria' => 'id_categoria',
        'id_categoria_padre' => 'id_categoria_padre',
        'unidad_medida' => 'unidad_medida',
        'precio' => 'precio',
        'estado' => 'estado',
        'id_proveedor' => 'id_proveedor',
        'arbol' => 'arbol',
        'filas' => 'filas',
        'pagina' => 'pagina',
        'por_pagina' => 'por_pagina',
    ],
];
