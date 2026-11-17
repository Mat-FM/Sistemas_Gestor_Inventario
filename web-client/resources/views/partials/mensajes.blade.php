@foreach (['exito' => 'success', 'aviso' => 'info', 'error' => 'danger'] as $clave => $tipo)
    @if (session($clave))
        <div class="alert alert-{{ $tipo }} d-flex gap-2 align-items-start" role="{{ $clave === 'error' ? 'alert' : 'status' }}">
            <i class="bi bi-{{ ['exito' => 'check-circle', 'aviso' => 'info-circle', 'error' => 'exclamation-triangle'][$clave] }} mt-1"></i>
            <div>{{ session($clave) }}</div>
        </div>
    @endif
@endforeach
