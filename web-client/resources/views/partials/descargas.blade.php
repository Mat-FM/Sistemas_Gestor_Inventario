{{-- Botones para bajar el reporte con los mismos filtros. Recibe $ruta (nombre de la ruta) y $filtros. --}}
@php($consulta = array_filter($consulta ?? request()->except('formato', 'pagina'), fn ($v) => $v !== null && $v !== ''))
<div class="d-flex flex-wrap gap-2 mb-3">
    <a class="btn btn-outline-primary" href="{{ route($ruta, $consulta + ['formato' => 'csv']) }}"><i class="bi bi-filetype-csv"></i> Descargar CSV</a>
    <a class="btn btn-outline-primary" href="{{ route($ruta, $consulta + ['formato' => 'pdf']) }}"><i class="bi bi-filetype-pdf"></i> Descargar PDF</a>
</div>
