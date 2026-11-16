"""Llamada 9 de la Tabla 2: ms-notificaciones → servidor de correo externo (aviso).

Usa smtplib de la biblioteca estándar. Si no hay SMTP_HOST configurado, no se envía nada y la
alerta sigue visible en la interfaz.
"""
import smtplib
from email.message import EmailMessage

from .. import logger

_smtp = {}


def iniciar(config):
    _smtp.clear()
    _smtp.update(config.smtp)


def configurado():
    return bool(_smtp.get("host") and _smtp.get("remitente"))


def enviar(destinatarios, asunto, texto):
    """Envía un correo a todos los destinatarios en copia oculta. Devuelve True si el servidor lo aceptó."""
    if not destinatarios or not configurado():
        return False
    mensaje = EmailMessage()
    mensaje["From"] = _smtp["remitente"]
    # Los destinatarios van solo en el sobre (copia oculta): nadie ve el correo de los demás.
    mensaje["To"] = _smtp["remitente"]
    mensaje["Subject"] = asunto
    mensaje.set_content(texto)
    try:
        clase = smtplib.SMTP_SSL if _smtp["port"] == 465 else smtplib.SMTP
        with clase(_smtp["host"], _smtp["port"], timeout=10) as servidor:
            if clase is smtplib.SMTP:
                servidor.ehlo()
                if servidor.has_extn("starttls"):
                    servidor.starttls()
                    servidor.ehlo()
            if _smtp["user"]:
                servidor.login(_smtp["user"], _smtp["password"])
            servidor.send_message(mensaje, to_addrs=destinatarios)
        return True
    except (smtplib.SMTPException, OSError) as error:
        logger.warn("correo no enviado", destino="servidor de correo", causa=str(error), destinatarios=len(destinatarios))
        return False
