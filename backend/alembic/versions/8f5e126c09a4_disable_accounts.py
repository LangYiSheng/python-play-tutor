"""Persist whether a user account is disabled."""

import sqlalchemy as sa
from alembic import op

revision = "8f5e126c09a4"
down_revision = "742b61a90dc4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM users WHERE disabled")):
        raise RuntimeError("存在已停用的账号，降级将恢复这些账号的登录权限")
    op.drop_column("users", "disabled")
