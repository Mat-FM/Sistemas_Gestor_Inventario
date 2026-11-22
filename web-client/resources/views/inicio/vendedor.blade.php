@extends('layouts.app')

@section('titulo', 'Buscar')

@section('contenido')
    @include('partials.saludo', ['frase' => '¿Qué producto buscas? Te decimos cuántas unidades hay y en qué bodega.'])
    <form method="get" action="{{ route('stock') }}" role="search" class="tarjeta">
        <div class="buscador mb-3">
            <i class="bi bi-search"></i>
            <input class="form-control" type="search" name="q" placeholder="Nombre o código del producto" autofocus aria-label="Buscar producto">
        </div>
        <button class="btn btn-primary btn-lg w-100">Buscar</button>
    </form>
@endsection
