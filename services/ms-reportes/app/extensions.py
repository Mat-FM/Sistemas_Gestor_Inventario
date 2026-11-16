"""Extensiones de Flask. Se crean aquí, sin aplicación, para que los modelos las importen sin ciclos."""

from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
migrate = Migrate()
