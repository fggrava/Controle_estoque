"""Modelo v1. Cada posição é identificada por material/centro/depósito."""

from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import String, Numeric, ForeignKey, UniqueConstraint, JSON, DateTime
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    login: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str]
    password: Mapped[str]
    role: Mapped[str] = mapped_column(default="user")
    active: Mapped[bool] = mapped_column(default=True)


class AuthSession(Base):
    __tablename__ = "sessions"
    token: Mapped[str] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    csrf: Mapped[str]
    expires: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Attempt(Base):
    __tablename__ = "login_attempts"
    key: Mapped[str] = mapped_column(primary_key=True)
    count: Mapped[int] = mapped_column(default=0)
    since: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class State(Base):
    __tablename__ = "state"
    id: Mapped[int] = mapped_column(primary_key=True)
    cycle: Mapped[int] = mapped_column(default=0)
    revision: Mapped[int] = mapped_column(default=0)
    exported: Mapped[int] = mapped_column(default=0)
    started: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Material(Base):
    __tablename__ = "materials"
    __table_args__ = (UniqueConstraint("code", "center", "depot"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(80), index=True)
    center: Mapped[str] = mapped_column(String(30))
    depot: Mapped[str] = mapped_column(String(30))
    description: Mapped[str]
    unit: Mapped[str]
    depot_name: Mapped[str] = mapped_column(default="")
    deletion: Mapped[str] = mapped_column(default="")
    kind: Mapped[str] = mapped_column(default="")
    location: Mapped[str] = mapped_column(default="")
    minimum: Mapped[Decimal] = mapped_column(Numeric(18, 3), default=0)
    base: Mapped[Decimal] = mapped_column(Numeric(18, 3), default=0)
    balance: Mapped[Decimal] = mapped_column(Numeric(18, 3), default=0)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(18, 6), default=0)
    active: Mapped[bool] = mapped_column(default=True)


class Attendance(Base):
    __tablename__ = "attendances"
    __table_args__ = (UniqueConstraint("user_id", "client_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[str]
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    cycle: Mapped[int]
    revision: Mapped[int] = mapped_column(default=1)
    os: Mapped[str]
    receiver: Mapped[str]
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    status: Mapped[str] = mapped_column(default="active")
    sap_document: Mapped[str] = mapped_column(default="")


class Item(Base):
    __tablename__ = "items"
    id: Mapped[int] = mapped_column(primary_key=True)
    attendance_id: Mapped[int] = mapped_column(ForeignKey("attendances.id"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("materials.id"))
    description: Mapped[str]
    code: Mapped[str]
    unit: Mapped[str]
    center: Mapped[str]
    depot: Mapped[str]
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3))
    cost: Mapped[Decimal] = mapped_column(Numeric(18, 6))


class Import(Base):
    __tablename__ = "imports"
    id: Mapped[int] = mapped_column(primary_key=True)
    cycle: Mapped[int]
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    filename: Mapped[str]
    digest: Mapped[str]
    snapshot: Mapped[dict] = mapped_column(JSON)
    same_confirmed: Mapped[bool]


class Export(Base):
    __tablename__ = "exports"
    id: Mapped[int] = mapped_column(primary_key=True)
    cycle: Mapped[int]
    revision: Mapped[int]
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Audit(Base):
    __tablename__ = "audit"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    action: Mapped[str]
    detail: Mapped[dict] = mapped_column(JSON)


# Constraints também protegem importações e operações administrativas.
from sqlalchemy import CheckConstraint, Index

User.__table__.append_constraint(
    CheckConstraint("role in ('admin','user')", name="ck_user_role")
)
Material.__table__.append_constraint(
    CheckConstraint(
        "balance >= 0 and base >= 0 and unit_cost >= 0 and minimum >= 0",
        name="ck_material_nonnegative",
    )
)
Item.__table__.append_constraint(
    CheckConstraint("quantity > 0 and cost >= 0", name="ck_item_quantity")
)
Attendance.__table__.append_constraint(
    CheckConstraint("status in ('active','cancelled')", name="ck_attendance_status")
)
Index("ix_attendance_user_created", Attendance.user_id, Attendance.created)
Index("ix_attendance_cycle", Attendance.cycle)
