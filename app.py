import os, io, re, secrets, hashlib
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from functools import wraps
from zoneinfo import ZoneInfo
from flask import Flask, request, jsonify, g, send_file, render_template
from sqlalchemy import create_engine, select, delete, func
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.exceptions import (
    BadRequest,
    Forbidden,
    Unauthorized,
    Conflict,
    HTTPException,
    TooManyRequests,
)
from models import (
    Base,
    User,
    AuthSession,
    Attempt,
    State,
    Material,
    Attendance,
    Item,
    Import,
    Export,
    Audit,
    now,
)
from services import (
    parse_base,
    snapshot,
    same_balances,
    quantity,
    number,
    excel,
    HEADERS,
)

app = Flask(__name__)
app.config.update(MAX_CONTENT_LENGTH=3_500_000)
engine = None


def db():
    global engine
    if "db" not in g:
        if engine is None:
            url = os.environ.get("DATABASE_URL", "")
            if not url:
                raise RuntimeError("DATABASE_URL não configurada")
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql+psycopg://", 1)
            elif url.startswith("postgresql://"):
                url = url.replace("postgresql://", "postgresql+psycopg://", 1)
            args = {"connect_timeout": 10}
            if os.environ.get("VERCEL"):
                args.update(sslmode="verify-full", sslrootcert="system")
            engine = create_engine(
                url,
                pool_pre_ping=True,
                pool_size=2,
                max_overflow=1,
                hide_parameters=True,
                connect_args=args if not url.startswith("sqlite") else {},
            )
        g.db = Session(engine)
    return g.db


@app.teardown_appcontext
def close_db(error):
    if "db" in g:
        g.db.close()


def hash_token(t):
    return hashlib.sha256(t.encode()).hexdigest()


def utc(d):
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d


def auth(admin=False):
    def deco(fn):
        @wraps(fn)
        def wrapped(*a, **kw):
            sess = db().get(AuthSession, hash_token(request.cookies.get("session", "")))
            if not sess or utc(sess.expires) < now():
                raise Unauthorized("Entre novamente.")
            u = db().get(User, sess.user_id)
            if not u or not u.active:
                raise Unauthorized("Acesso desativado.")
            if admin and u.role != "admin":
                raise Forbidden("Somente administrador.")
            if request.method not in ("GET", "HEAD") and not secrets.compare_digest(
                request.headers.get("X-CSRF-Token", ""), sess.csrf
            ):
                raise Forbidden("Token de segurança inválido.")
            g.user = u
            g.session = sess
            return fn(*a, **kw)

        return wrapped

    return deco


@app.before_request
def guard_origin():
    if request.path.startswith("/api/") and request.method not in ("GET", "HEAD"):
        if os.environ.get("VERCEL") and not os.environ.get("APP_ORIGIN"):
            raise RuntimeError("APP_ORIGIN não configurada")
        allowed = os.environ.get("APP_ORIGIN", request.host_url.rstrip("/"))
        if request.headers.get("Origin") != allowed:
            raise Forbidden("Origem não autorizada.")


@app.after_request
def headers(r):
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["X-Frame-Options"] = "DENY"
    r.headers["Referrer-Policy"] = "same-origin"
    r.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    r.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if os.environ.get("VERCEL"):
        r.headers["Strict-Transport-Security"] = "max-age=31536000"
    if request.path.startswith("/api/"):
        r.headers["Cache-Control"] = "no-store"
    return r


@app.errorhandler(HTTPException)
def http_error(e):
    return jsonify(error=e.description), e.code


@app.errorhandler(ValueError)
@app.errorhandler(TypeError)
@app.errorhandler(KeyError)
def invalid_input(e):
    return jsonify(error="Campos inválidos. Confira os dados informados."), 400


@app.errorhandler(Exception)
def error(e):
    app.logger.error("Falha na requisição: %s", type(e).__name__)
    return (
        jsonify(
            error="Não foi possível concluir a operação. Verifique a configuração ou tente novamente."
        ),
        500,
    )


def body():
    b = request.get_json() or {}
    if not isinstance(b, dict):
        raise BadRequest("Objeto JSON obrigatório.")
    return b


def text(v, maxlen=150):
    return str(v or "").strip()[:maxlen]


def lock():
    s = db().scalar(select(State).where(State.id == 1).with_for_update())
    if not s:
        raise Conflict("Banco não inicializado: execute o comando init-db.")
    return s


def audit(action, detail):
    db().add(Audit(user_id=g.user.id, action=action, detail=detail))


def user_json(u):
    return dict(id=u.id, name=u.name, login=u.login, role=u.role, active=u.active)


def m_json(m):
    return dict(
        id=m.id,
        code=m.code,
        description=m.description,
        unit=m.unit,
        center=m.center,
        depot=m.depot,
        depot_name=m.depot_name,
        kind=m.kind,
        deletion=m.deletion,
        location=m.location,
        minimum=str(m.minimum),
        balance=str(m.balance),
        unit_cost=str(m.unit_cost),
        active=m.active,
    )


def att_json(a):
    items = db().scalars(select(Item).where(Item.attendance_id == a.id)).all()
    return dict(
        id=a.id,
        os=a.os,
        receiver=a.receiver,
        user_id=a.user_id,
        user=db().get(User, a.user_id).name,
        cycle=a.cycle,
        revision=a.revision,
        created=utc(a.created).isoformat(),
        status=a.status,
        sap_document=a.sap_document,
        items=[
            dict(
                material_id=i.material_id,
                code=i.code,
                description=i.description,
                unit=i.unit,
                quantity=str(i.quantity),
                cost=str(i.cost),
                total=str((i.quantity * i.cost).quantize(Decimal(".01"))),
            )
            for i in items
        ],
    )


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/sw.js")
def sw():
    r = send_file("static/sw.js")
    r.headers["Service-Worker-Allowed"] = "/"
    r.headers["Cache-Control"] = "no-cache"
    return r


@app.post("/api/login")
def login():
    b = body()
    name = text(b.get("login")).lower()
    s = db()
    key = hash_token(name)
    # Persistente entre instâncias Vercel. Janela de bloqueio por login.
    s.execute(select(State).where(State.id == 1).with_for_update())
    a = s.get(Attempt, key)
    if not a:
        a = Attempt(key=key, count=0, since=now())
        s.add(a)
    if now() - utc(a.since) > timedelta(minutes=15):
        a.count = 0
        a.since = now()
    if a.count >= 10:
        raise TooManyRequests("Muitas tentativas. Aguarde 15 minutos.")
    u = s.scalar(select(User).where(User.login == name))
    valid = check_password_hash(
        u.password if u else generate_password_hash("dummy-password"),
        str(b.get("password", ""))[:500],
    )
    if not u or not u.active or not valid:
        a.count += 1
        s.commit()
        raise Unauthorized("Login ou senha inválidos.")
    a.count = 0
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    s.add(
        AuthSession(
            token=hash_token(token),
            user_id=u.id,
            csrf=csrf,
            expires=now() + timedelta(hours=12),
        )
    )
    s.commit()
    r = jsonify(user=user_json(u), csrf=csrf)
    r.set_cookie(
        "session",
        token,
        httponly=True,
        secure=bool(os.environ.get("VERCEL")),
        samesite="Strict",
        max_age=43200,
    )
    return r


@app.get("/api/me")
@auth()
def me():
    return jsonify(user=user_json(g.user), csrf=g.session.csrf)


@app.post("/api/logout")
@auth()
def logout():
    db().delete(g.session)
    db().commit()
    r = jsonify(ok=True)
    r.delete_cookie("session")
    return r


@app.get("/api/state")
@auth()
def state():
    s = db().get(State, 1)
    return jsonify(
        cycle=s.cycle,
        revision=s.revision,
        exported=s.exported,
        started=utc(s.started).isoformat(),
    )


@app.get("/api/materials")
@auth()
def materials():
    return jsonify(
        [
            m_json(m)
            for m in db().scalars(select(Material).order_by(Material.description)).all()
        ]
    )


@app.patch("/api/materials/<int:mid>")
@auth(True)
def patch_material(mid):
    lock()
    m = db().get(Material, mid)
    if not m:
        raise BadRequest("Material inexistente.")
    b = body()
    before = m_json(m)
    m.location = text(b.get("location", m.location))
    m.minimum = number(b.get("minimum", m.minimum))
    if m.minimum < 0:
        raise BadRequest("Mínimo inválido.")
    m.description = text(b.get("description", m.description))
    m.active = bool(b.get("active", m.active))
    db().get(State, 1).revision += 1
    audit("material.edit", {"before": before, "after": m_json(m)})
    db().commit()
    return jsonify(ok=True)


@app.get("/api/attendances")
@auth()
def attendances():
    q = select(Attendance).order_by(Attendance.created.desc())
    if g.user.role != "admin":
        q = q.where(Attendance.user_id == g.user.id)
    return jsonify([att_json(a) for a in db().scalars(q).all()])


def set_items(a, rows):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise BadRequest("Informe entre 1 e 100 itens.")
    ids = set()
    for r in rows:
        mid = int(r["material_id"])
        q = quantity(r["quantity"])
        if mid in ids:
            raise BadRequest("Material repetido no atendimento.")
        ids.add(mid)
        m = db().get(Material, mid)
        if not m or not m.active or m.deletion:
            raise BadRequest("Material inativo ou indisponível.")
        if m.balance < q:
            raise Conflict(f"Saldo insuficiente: {m.code}.")
        m.balance -= q
        db().add(
            Item(
                attendance_id=a.id,
                material_id=mid,
                quantity=q,
                cost=m.unit_cost,
                description=m.description,
                code=m.code,
                unit=m.unit,
                center=m.center,
                depot=m.depot,
            )
        )


@app.post("/api/attendances")
@auth()
def create_att():
    s = lock()
    b = body()
    cid = text(b.get("client_id"), 80)
    if not re.fullmatch(r"[a-zA-Z0-9-]{16,80}", cid):
        raise BadRequest("Identificador de lançamento inválido.")
    existing = db().scalar(
        select(Attendance).where(
            Attendance.user_id == g.user.id, Attendance.client_id == cid
        )
    )
    if existing:
        return jsonify(id=existing.id, duplicate=True)
    if int(b.get("cycle", -1)) != s.cycle:
        raise Conflict(
            "Base alterada. Revise o lançamento pendente com o administrador."
        )
    order = text(b.get("os"), 30)
    receiver = text(b.get("receiver"))
    if not re.fullmatch(r"\d{1,20}", order) or not receiver:
        raise BadRequest("Informe OS numérica e responsável pela retirada.")
    rows = b.get("items")
    if not isinstance(rows, list):
        raise BadRequest("Itens obrigatórios.")
    ids = [int(r["material_id"]) for r in rows]
    recent = db().scalar(
        select(Attendance.id)
        .join(Item, Item.attendance_id == Attendance.id)
        .where(
            Attendance.os == order,
            Attendance.status == "active",
            Attendance.created >= now() - timedelta(minutes=30),
            Item.material_id.in_(ids),
        )
        .limit(1)
    )
    if recent and b.get("confirm_duplicate") is not True:
        raise Conflict(
            "Possível duplicidade: mesmo material e OS nos últimos 30 minutos. Revise e confirme expressamente."
        )
    a = Attendance(
        client_id=cid, user_id=g.user.id, cycle=s.cycle, os=order, receiver=receiver
    )
    db().add(a)
    db().flush()
    set_items(a, b.get("items"))
    s.revision += 1
    audit("attendance.create", {"id": a.id, "client_id": cid})
    db().commit()
    return jsonify(id=a.id)


@app.patch("/api/attendances/<int:aid>")
@auth()
def edit_att(aid):
    s = lock()
    b = body()
    a = db().get(Attendance, aid)
    if not a:
        raise BadRequest("Atendimento inexistente.")
    if g.user.role != "admin" and a.user_id != g.user.id:
        raise Forbidden("Somente seus lançamentos.")
    if a.cycle != s.cycle or a.status != "active" or a.sap_document:
        raise Conflict(
            "Ciclo encerrado, cancelado ou já lançado no SAP. Correção exige conciliação."
        )
    if int(b.get("revision", -1)) != a.revision:
        raise Conflict("Registro alterado por outro usuário. Atualize a tela.")
    reason = text(b.get("reason"))
    if not reason:
        raise BadRequest("Justificativa obrigatória.")
    before = att_json(a)
    order = text(b.get("os", a.os), 30)
    receiver = text(b.get("receiver", a.receiver))
    if not re.fullmatch(r"\d{1,20}", order) or not receiver:
        raise BadRequest("Informe OS numérica e responsável.")
    a.os = order
    a.receiver = receiver
    for item in db().scalars(select(Item).where(Item.attendance_id == a.id)).all():
        db().get(Material, item.material_id).balance += item.quantity
    if b.get("cancel"):
        a.status = "cancelled"
    else:
        db().execute(delete(Item).where(Item.attendance_id == a.id))
        db().flush()
        set_items(a, b.get("items"))
    a.revision += 1
    s.revision += 1
    audit(
        "attendance.correct",
        {"before": before, "reason": reason, "cancel": bool(b.get("cancel"))},
    )
    db().commit()
    return jsonify(ok=True)


@app.patch("/api/attendances/<int:aid>/sap")
@auth(True)
def mark_sap(aid):
    s = lock()
    a = db().get(Attendance, aid)
    doc = text(body().get("document"), 30)
    if not a or a.status != "active" or not doc:
        raise BadRequest("Atendimento ou documento inválido.")
    audit("sap.confirm", {"id": aid, "before": a.sap_document, "document": doc})
    a.sap_document = doc
    s.revision += 1
    db().commit()
    return jsonify(ok=True)


@app.post("/api/import/preview")
@auth(True)
def import_preview():
    f = request.files.get("file")
    if not f or not f.filename.lower().endswith(".xlsx"):
        raise BadRequest("Selecione um arquivo XLSX.")
    rows, digest = parse_base(f.read())
    s = db().get(State, 1)
    previous = db().scalar(select(Import).order_by(Import.id.desc()))
    same = bool(previous and same_balances(previous.snapshot, snapshot(rows)))
    return jsonify(
        count=len(rows),
        digest=digest,
        cycle=s.cycle,
        revision=s.revision,
        same=same,
        needs_export=s.revision != s.exported,
        missing=len(set(previous.snapshot if previous else {}) - set(snapshot(rows))),
        sample=[
            {**r, "base": str(r["base"]), "unit_cost": str(r["unit_cost"])}
            for r in rows[:8]
        ],
    )


@app.post("/api/import/confirm")
@auth(True)
def import_confirm():
    s = lock()
    if s.revision != s.exported:
        raise Conflict(
            "Exporte todos os lançamentos e alterações do ciclo antes de atualizar a base."
        )
    if (
        int(request.form.get("cycle", -1)) != s.cycle
        or int(request.form.get("revision", -1)) != s.revision
    ):
        raise Conflict("O ciclo foi alterado. Valide novamente.")
    if request.form.get("reconciled") != "true":
        raise BadRequest(
            "Confirme que a nova posição contempla as retiradas dos ciclos anteriores."
        )
    f = request.files.get("file")
    if not f:
        raise BadRequest("Selecione o arquivo.")
    rows, digest = parse_base(f.read())
    if digest != request.form.get("digest"):
        raise Conflict("Arquivo diferente da prévia. Valide novamente.")
    previous = db().scalar(select(Import).order_by(Import.id.desc()))
    same = bool(previous and same_balances(previous.snapshot, snapshot(rows)))
    if same and request.form.get("confirm_same") != "true":
        raise Conflict(
            "Todos os saldos são iguais aos da base anterior. Confirmação adicional obrigatória."
        )
    # Substituição completa: itens ausentes ficam inativos com saldo zero.
    existing = {
        (m.code, m.center, m.depot): m for m in db().scalars(select(Material)).all()
    }
    for m in existing.values():
        m.active = False
        m.balance = 0
    s.cycle += 1
    s.revision = 0
    s.exported = 0
    s.started = now()
    for r in rows:
        m = existing.get((r["code"], r["center"], r["depot"]))
        if not m:
            m = Material(**r, balance=r["base"])
            db().add(m)
        else:
            for k, v in r.items():
                setattr(m, k, v)
            m.balance = r["base"]
        m.active = not bool(r["deletion"])
    db().add(
        Import(
            cycle=s.cycle,
            user_id=g.user.id,
            filename=text(f.filename),
            digest=digest,
            snapshot=snapshot(rows),
            same_confirmed=same,
        )
    )
    audit(
        "import.replace",
        {
            "cycle": s.cycle,
            "digest": digest,
            "same": same,
            "rows": len(rows),
            "reconciled": True,
        },
    )
    db().commit()
    return jsonify(ok=True, cycle=s.cycle)


@app.get("/api/import/template")
@auth(True)
def template():
    return send_file(
        excel({"Base": [HEADERS]}),
        download_name="Modelo_base_estoque.xlsx",
        as_attachment=True,
    )


def report_rows(att):
    rows = [
        [
            "Atendimento",
            "OS",
            "Responsável retirada",
            "Liberado por",
            "Data retirada",
            "Status",
            "Material",
            "Descrição",
            "Unidade",
            "Centro",
            "Depósito",
            "Quantidade",
            "Valor unitário",
            "Valor saída",
            "Documento SAP",
        ]
    ]
    grouped = {}
    for a in att:
        for i in db().scalars(select(Item).where(Item.attendance_id == a.id)).all():
            m = db().get(Material, i.material_id)
            rows.append(
                [
                    a.id,
                    a.os,
                    a.receiver,
                    db().get(User, a.user_id).name,
                    utc(a.created)
                    .astimezone(ZoneInfo("America/Sao_Paulo"))
                    .strftime("%d/%m/%Y %H:%M"),
                    a.status,
                    i.code,
                    i.description,
                    i.unit,
                    i.center,
                    i.depot,
                    i.quantity,
                    i.cost,
                    (i.quantity * i.cost).quantize(Decimal(".01")),
                    a.sap_document,
                ]
            )
            if a.status == "active" and not a.sap_document:
                key = (a.os, i.code, i.center, i.depot, i.unit)
                grouped[key] = grouped.get(key, Decimal(0)) + i.quantity
    sap = [
        ["Ordem", "Material", "Centro", "Depósito", "UM", "Quantidade", "Movimento"]
    ] + [[*key, q, "261"] for key, q in grouped.items()]
    return rows, sap


@app.post("/api/export")
@auth(True)
def export():
    s = lock()
    b = body()
    full = b.get("full") is True
    att = (
        db()
        .scalars(
            select(Attendance)
            .where(Attendance.cycle == s.cycle)
            .order_by(Attendance.id)
        )
        .all()
        if full
        else filtered_att(b)
    )
    rows, sap = report_rows(att)
    history = [["Data", "Usuário", "Ação", "Detalhe"]]
    if full:
        import json

        for a in (
            db()
            .scalars(select(Audit).where(Audit.created >= s.started).order_by(Audit.id))
            .all()
        ):
            history.append(
                [
                    utc(a.created).isoformat(),
                    a.user_id,
                    a.action,
                    json.dumps(a.detail, ensure_ascii=False),
                ]
            )
    output = excel(
        {"Lançamentos": rows, "SAP_Agrupado": sap, "Auditoria_ciclo": history}
    )
    if full:
        s.exported = s.revision
        db().add(Export(cycle=s.cycle, revision=s.revision, user_id=g.user.id))
        audit("export.cycle", {"cycle": s.cycle, "revision": s.revision})
    db().commit()
    return send_file(
        output, download_name=f"Lancamentos_ciclo_{s.cycle}.xlsx", as_attachment=True
    )


def filtered_att(b):
    start = text(b.get("start"))
    end = text(b.get("end"))
    uid = text(b.get("user"))
    if (
        not re.fullmatch(r"\d{4}-\d{2}-\d{2}", start)
        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end)
        or start > end
    ):
        raise BadRequest("Período inválido.")
    tz = ZoneInfo("America/Sao_Paulo")
    try:
        lo = datetime.fromisoformat(start).replace(tzinfo=tz)
        hi = datetime.fromisoformat(end).replace(tzinfo=tz) + timedelta(days=1)
    except ValueError:
        raise BadRequest("Datas inválidas.")
    q = select(Attendance).where(Attendance.created >= lo, Attendance.created < hi)
    if g.user.role != "admin":
        q = q.where(Attendance.user_id == g.user.id)
    elif uid:
        q = q.where(Attendance.user_id == int(uid))
    return db().scalars(q.order_by(Attendance.created.desc())).all()


@app.get("/api/dashboard")
@auth()
def dashboard():
    att = filtered_att(request.args)
    active = [a for a in att if a.status == "active"]
    tot = Decimal(0)
    units = {}
    days = {}
    for a in active:
        day = (
            utc(a.created)
            .astimezone(ZoneInfo("America/Sao_Paulo"))
            .strftime("%d/%m/%Y")
        )
        days[day] = days.get(day, 0) + 1
        for i in db().scalars(select(Item).where(Item.attendance_id == a.id)).all():
            tot += (i.quantity * i.cost).quantize(Decimal(".01"))
            unit = i.unit
            units[unit] = str(Decimal(units.get(unit, "0")) + i.quantity)
    return jsonify(
        attendances=len(active),
        total=str(tot.quantize(Decimal(".01"))),
        units=units,
        days=days,
        records=[att_json(a) for a in att],
    )


@app.get("/api/users")
@auth(True)
def users():
    return jsonify(
        [user_json(u) for u in db().scalars(select(User).order_by(User.name)).all()]
    )


def validate_password(p):
    if len(p) < 12 or len(p) > 200:
        raise BadRequest("Senha deve ter de 12 a 200 caracteres.")


@app.post("/api/users")
@auth(True)
def new_user():
    lock()
    b = body()
    p = str(b.get("password", ""))
    validate_password(p)
    login = text(b.get("login"), 80).lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,80}", login):
        raise BadRequest(
            "Login: 3–80 letras minúsculas, números, ponto, hífen ou sublinhado."
        )
    if db().scalar(select(User).where(User.login == login)):
        raise Conflict("Login já cadastrado.")
    u = User(
        login=login,
        name=text(b.get("name")),
        password=generate_password_hash(p),
        role="admin" if b.get("role") == "admin" else "user",
    )
    if not u.name:
        raise BadRequest("Nome obrigatório.")
    db().add(u)
    audit("user.create", {"login": login})
    db().commit()
    return jsonify(ok=True)


@app.patch("/api/users/<int:uid>")
@auth(True)
def edit_user(uid):
    lock()
    u = db().get(User, uid)
    b = body()
    if not u:
        raise BadRequest("Usuário inexistente.")
    active = b.get("active", u.active)
    role = b.get("role", u.role)
    if role not in ("admin", "user") or not isinstance(active, bool):
        raise BadRequest("Perfil inválido.")
    if u.id == g.user.id and (not active or role != "admin"):
        raise BadRequest("Não desative ou remova seu próprio perfil de administrador.")
    newlogin = text(b.get("login", u.login), 80).lower()
    if not re.fullmatch(r"[a-z0-9_.-]{3,80}", newlogin):
        raise BadRequest("Login inválido.")
    other = db().scalar(select(User).where(User.login == newlogin, User.id != uid))
    if other:
        raise Conflict("Login já utilizado.")
    before = user_json(u)
    u.login = newlogin
    u.name = text(b.get("name", u.name))
    u.active = active
    u.role = role
    if b.get("password"):
        validate_password(b["password"])
        u.password = generate_password_hash(b["password"])
    db().execute(delete(AuthSession).where(AuthSession.user_id == uid))
    audit("user.edit", {"before": before, "after": user_json(u)})
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/users/<int:uid>")
@auth(True)
def delete_user(uid):
    lock()
    u = db().get(User, uid)
    if not u or uid == g.user.id:
        raise BadRequest("Não é possível excluir este usuário.")
    has_history = any(
        db().scalar(
            select(func.count()).select_from(cls).where(getattr(cls, "user_id") == uid)
        )
        for cls in [Attendance, Audit, Import, Export]
    )
    db().execute(delete(AuthSession).where(AuthSession.user_id == uid))
    if has_history:
        u.active = False
    else:
        db().delete(u)
    audit("user.delete", {"id": uid, "deactivated": bool(has_history)})
    db().commit()
    return jsonify(deactivated=bool(has_history))


@app.post("/api/inventory/<int:mid>")
@auth(True)
def inventory(mid):
    s = lock()
    b = body()
    m = db().get(Material, mid)
    if not m or not m.active:
        raise BadRequest("Material indisponível.")
    if int(b.get("cycle", -1)) != s.cycle:
        raise Conflict("Base mudou.")
    if number(b.get("expected")) != m.balance:
        raise Conflict("Saldo mudou durante a contagem. Atualize e confira.")
    counted = number(b.get("counted"))
    reason = text(b.get("reason"))
    if counted < 0 or counted != counted.quantize(Decimal(".001")) or not reason:
        raise BadRequest("Informe contagem não negativa e justificativa.")
    old = m.balance
    m.balance = counted
    s.revision += 1
    audit(
        "inventory.adjust",
        {
            "material": mid,
            "previous": str(old),
            "counted": str(counted),
            "difference": str(counted - old),
            "reason": reason,
            "cycle": s.cycle,
        },
    )
    db().commit()
    return jsonify(ok=True)


@app.get("/api/audit")
@auth(True)
def audits():
    return jsonify(
        [
            dict(
                id=a.id,
                created=utc(a.created).isoformat(),
                user_id=a.user_id,
                action=a.action,
                detail=a.detail,
            )
            for a in db()
            .scalars(select(Audit).order_by(Audit.id.desc()).limit(500))
            .all()
        ]
    )


@app.cli.command("init-db")
def init_db():
    """Executar uma vez, fora do build Vercel, com conexão direta."""
    from sqlalchemy import create_engine

    url = (
        os.environ.get("DATABASE_URL_UNPOOLED", os.environ.get("DATABASE_URL", ""))
        .replace("postgres://", "postgresql+psycopg://", 1)
        .replace("postgresql://", "postgresql+psycopg://", 1)
    )
    e = create_engine(url)
    Base.metadata.create_all(e)
    with Session(e) as s:
        if not s.get(State, 1):
            s.add(State(id=1))
            s.commit()
    print("Esquema v1 inicializado.")


@app.cli.command("create-admin")
def create_admin():
    import click

    login = click.prompt("Login").strip().lower()
    name = click.prompt("Nome")
    p = click.prompt(
        "Senha (mínimo 12 caracteres)", hide_input=True, confirmation_prompt=True
    )
    validate_password(p)
    if not re.fullmatch(r"[a-z0-9_.-]{3,80}", login):
        raise click.ClickException("Login inválido.")
    with app.app_context():
        if db().scalar(select(User).where(User.login == login)):
            raise click.ClickException("Login já existe.")
        db().add(
            User(
                login=login, name=name, password=generate_password_hash(p), role="admin"
            )
        )
        db().commit()
    print("Administrador criado. Nenhuma senha padrão existe.")


@app.post("/api/materials")
@auth(True)
def new_material():
    s = lock()
    b = body()
    if s.revision != s.exported:
        raise Conflict(
            "Exporte o ciclo antes de inserir saldo inicial de um novo material."
        )
    code = text(b.get("code"), 80)
    center = text(b.get("center"), 30)
    depot = text(b.get("depot"), 30).zfill(4)
    desc = text(b.get("description"))
    unit = text(b.get("unit"), 20)
    if not all([code, center, depot, desc, unit]):
        raise BadRequest("Preencha código, centro, depósito, descrição e unidade.")
    if db().scalar(
        select(Material).where(
            Material.code == code, Material.center == center, Material.depot == depot
        )
    ):
        raise Conflict("Material já existe neste centro e depósito.")
    balance = number(b.get("balance", 0))
    cost = number(b.get("unit_cost", 0))
    if balance < 0 or cost < 0 or balance != balance.quantize(Decimal(".001")):
        raise BadRequest("Saldo ou valor inválido.")
    m = Material(
        code=code,
        center=center,
        depot=depot,
        description=desc,
        unit=unit,
        base=balance,
        balance=balance,
        unit_cost=cost,
    )
    db().add(m)
    s.revision += 1
    audit(
        "material.create",
        {
            "code": code,
            "center": center,
            "depot": depot,
            "balance": str(balance),
            "unit_cost": str(cost),
            "cycle": s.cycle,
        },
    )
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/materials/<int:mid>")
@auth(True)
def delete_material(mid):
    s = lock()
    m = db().get(Material, mid)
    if not m:
        raise BadRequest("Material inexistente.")
    if m.balance != 0:
        raise Conflict(
            "Material com saldo: concilie o estoque antes de excluir ou inativar."
        )
    used = db().scalar(
        select(func.count()).select_from(Item).where(Item.material_id == mid)
    )
    # Preserva também qualquer código citado nos snapshots de importação.
    if used or s.cycle > 0:
        m.active = False
    else:
        db().delete(m)
    s.revision += 1
    audit(
        "material.delete",
        {"id": mid, "deactivated": bool(used or s.cycle > 0), "cycle": s.cycle},
    )
    db().commit()
    return jsonify(ok=True)
