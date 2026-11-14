"""Se crean las tablas importaciones y errores_importacion (Figura 8 de la Entrega 2).

id_usuario guarda solo el identificador del usuario del API Gateway, sin clave foránea (RNF02).
tipo y estado son texto con una restricción CHECK que solo admite los valores de la lista.

Revision ID: ac1e2797a54c
Revises: 
Create Date: 2026-11-14 17:42:24.223748

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'ac1e2797a54c'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('importaciones',
    sa.Column('id_importacion', sa.BigInteger(), nullable=False),
    sa.Column('tipo', sa.Enum('PRODUCTOS', 'PROVEEDORES', 'STOCK_INICIAL', name='tipo_importacion', native_enum=False, create_constraint=True, length=20), nullable=False),
    sa.Column('nombre_archivo', sa.String(length=255), nullable=False),
    sa.Column('estado', sa.Enum('PROCESADA', 'CON_ERRORES', 'FALLIDA', name='estado_importacion', native_enum=False, create_constraint=True, length=20), nullable=False),
    sa.Column('filas_totales', sa.Integer(), nullable=False),
    sa.Column('filas_validas', sa.Integer(), nullable=False),
    sa.Column('filas_con_error', sa.Integer(), nullable=False),
    sa.Column('id_usuario', sa.BigInteger(), nullable=False),
    sa.Column('fecha', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id_importacion')
    )
    op.create_table('errores_importacion',
    sa.Column('id_error', sa.BigInteger(), nullable=False),
    sa.Column('id_importacion', sa.BigInteger(), nullable=False),
    sa.Column('numero_fila', sa.Integer(), nullable=False),
    sa.Column('campo', sa.String(length=100), nullable=True),
    sa.Column('mensaje', sa.String(length=500), nullable=False),
    sa.ForeignKeyConstraint(['id_importacion'], ['importaciones.id_importacion'], ),
    sa.PrimaryKeyConstraint('id_error')
    )
    with op.batch_alter_table('errores_importacion', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_errores_importacion_id_importacion'), ['id_importacion'], unique=False)



def downgrade():
    with op.batch_alter_table('errores_importacion', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_errores_importacion_id_importacion'))

    op.drop_table('errores_importacion')
    op.drop_table('importaciones')
