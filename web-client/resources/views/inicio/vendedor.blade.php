@extends('layouts.app')

@section('titulo', 'Buscar')

@section('contenido')
    <h1 class="h4 mb-3">¿Qué producto buscas?</h1>
    <form method="get" action="{{ route('stock') }}" role="search">
        <div class="buscador mb-3">
            <i class="bi bi-search"></i>
            <input class="form-control" type="search" name="q" placeholder="Nombre o código del producto" autofocus aria-label="Buscar producto">
        </div>
        <button class="btn btn-primary btn-lg w-100">Buscar</button>
    </form>
    <p class="text-suave text-center mt-3">Te mostramos cuántas unidades hay y en qué bodega.</p>
@endsection
