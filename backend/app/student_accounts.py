"""Teacher-owned classroom account provisioning and bounded roster imports."""
import csv
import io
import zipfile
from xml.etree.ElementTree import ParseError
from defusedxml.common import DefusedXmlException
from typing import Annotated, Literal
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .account_ids import normalize_student_id
from .auth import hash_password, require_teacher
from app.classrooms.access import own_classroom
from .db import get_db
from .models import AuthSession, Membership, TownPreviewStudent, User
from .password_policy import MIN_PASSWORD_LENGTH

router = APIRouter(prefix="/teacher/classrooms/{classroom_id}/students", tags=["student accounts"])
MAX_ROWS = 500
MAX_FILE = 2 * 1024 * 1024


class AccountNameInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        if not value.strip():
            raise ValueError("姓名不能为空")
        return value.strip()


class StudentInput(AccountNameInput):
    student_id: str = Field(min_length=1, max_length=32)

    @field_validator("student_id")
    @classmethod
    def valid_id(cls, value):
        return normalize_student_id(value)


class CreateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    students: list[StudentInput] = Field(min_length=1, max_length=MAX_ROWS)


def new_student_account(student_id: str, name: str) -> User:
    return User(student_id=student_id, name=name, role="student",
                password_hash=hash_password(student_id), must_change_password=True)


def inspect_students(db, classroom_id, students):
    seen, errors, result = set(), [], []
    existing = {u.student_id: u for u in db.scalars(select(User).where(User.student_id.in_([s.student_id for s in students])))}
    previews = set(db.scalars(select(TownPreviewStudent.student_user_id).where(
        TownPreviewStudent.student_user_id.in_([u.id for u in existing.values()]))))
    members = set(db.scalars(select(Membership.user_id).where(Membership.classroom_id == classroom_id)))
    from .classrooms.service import other_class_members
    from .models import Classroom
    elsewhere = set(db.scalars(other_class_members(db.get(Classroom, classroom_id)).where(
        Membership.user_id.in_([u.id for u in existing.values()]))))
    for index, student in enumerate(students, 2):
        old = existing.get(student.student_id)
        if student.student_id in seen:
            errors.append(f"第{index}行：学号重复")
        elif old and (old.role != "student" or old.id in previews):
            errors.append(f"第{index}行：该学号不能作为正式学生加入班级")
        elif old and old.id in elsewhere:
            errors.append(f"第{index}行：该学生已加入本课程的其他在教班级")
        elif old and old.id not in members and old.name != student.name:
            errors.append(f"第{index}行：学号与姓名不匹配，请核对名册")
        elif not old and len(student.student_id) < MIN_PASSWORD_LENGTH:
            errors.append(f"第{index}行：新生学号至少须有{MIN_PASSWORD_LENGTH}位，用于设置初始密码")
        else:
            action = ("existing" if old.id in members else "bind") if old else "create"
            result.append({**student.model_dump(), "name": old.name if old else student.name, "action": action})
        seen.add(student.student_id)
    if errors:
        raise HTTPException(422, "；".join(errors[:20]))
    return result


@router.get("")
def roster(classroom_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    own_classroom(db, user, classroom_id)
    rows = db.scalars(select(User).join(Membership).where(Membership.classroom_id == classroom_id, User.role == "student").order_by(User.student_id))
    return [{"id": u.id, "student_id": u.student_id, "name": u.name, "must_change_password": u.must_change_password,
             "disabled": u.disabled} for u in rows]


@router.post("", status_code=201)
def create_students(classroom_id: int, body: CreateInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    own_classroom(db, user, classroom_id, exclusive=True)
    rows = inspect_students(db, classroom_id, body.students)
    created = bound = 0
    try:
        for row in rows:
            if row["action"] == "existing":
                continue
            if row["action"] == "bind":
                student_id = db.scalar(select(User.id).where(User.student_id == row["student_id"]))
                db.add(Membership(user_id=student_id, classroom_id=classroom_id))
                bound += 1
                continue
            student = new_student_account(row["student_id"], row["name"])
            db.add(student)
            db.flush()
            db.add(Membership(user_id=student.id, classroom_id=classroom_id))
            created += 1
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "学号或班级关系已变化，请重新预览；本次未创建任何账号")
    return {"created": created, "bound": bound, "existing": len(rows) - created - bound}


def parse_table(filename, data):
    if len(data) > MAX_FILE:
        raise ValueError("文件不能超过2MB")
    if filename.lower().endswith(".csv"):
        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig")), strict=True))
    elif filename.lower().endswith(".xlsx"):
        from openpyxl import load_workbook
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if len(archive.infolist()) > 100 or sum(i.file_size for i in archive.infolist()) > 10 * 1024 * 1024:
                raise ValueError("工作簿解压后过大")
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
        try:
            if len(workbook.worksheets) != 1:
                raise ValueError("请仅保留一个工作表")
            sheet = workbook.worksheets[0]
            if (sheet.max_column or 0) > 2 or (sheet.max_row or 0) > MAX_ROWS + 1:
                raise ValueError("表格仅支持学号、姓名两列及最多500名学生")
            sheet.reset_dimensions()
            rows = []
            for cells in sheet.iter_rows(max_row=MAX_ROWS + 2, max_col=3):
                if any(c.data_type == "f" for c in cells):
                    raise ValueError("表格不能包含公式")
                values = [c.value for c in cells]
                if values[2] is not None:
                    raise ValueError("表格只能包含学号、姓名两列")
                rows.append(values[:2])
            if len(rows) > MAX_ROWS + 1:
                raise ValueError("每次导入最多500名学生")
        finally:
            workbook.close()
    else:
        raise ValueError("仅支持UTF-8 CSV或.xlsx文件")
    while rows and not any(v is not None and str(v).strip() for v in rows[-1]):
        rows.pop()
    if not rows or [str(v).strip() for v in rows[0]] != ["学号", "姓名"]:
        raise ValueError("首行必须依次为：学号、姓名")
    if not 1 <= len(rows) - 1 <= MAX_ROWS:
        raise ValueError("每次导入1–500名学生")
    students = []
    for index, row in enumerate(rows[1:], 2):
        if len(row) != 2:
            raise ValueError(f"第{index}行：需要学号和姓名两列")
        # Reject numeric Excel IDs: Excel may already have lost zeros or precision.
        if not isinstance(row[0], str):
            raise ValueError(f"第{index}行：请将学号设为文本格式后重新填写，以保留前导零")
        try:
            students.append(StudentInput(student_id=row[0], name=row[1]))
        except ValidationError:
            raise ValueError(f"第{index}行：学号须为1–32位数字，姓名须为1–80字")
    return students


@router.post("/import-preview")
def preview_import(classroom_id: int, file: UploadFile, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    own_classroom(db, user, classroom_id)
    try:
        students = parse_table(file.filename or "", file.file.read(MAX_FILE + 1))
    except (ValueError, UnicodeError, csv.Error, zipfile.BadZipFile, KeyError, OSError, ParseError, DefusedXmlException) as exc:
        raise HTTPException(422, str(exc) if isinstance(exc, ValueError) else "表格无法读取，请检查文件格式")
    finally:
        file.file.close()
    return {"students": inspect_students(db, classroom_id, students)}


class BatchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    student_ids: list[str] = Field(min_length=1, max_length=MAX_ROWS)
    action: Literal["reset-password", "remove"]

    @field_validator("student_ids")
    @classmethod
    def valid_ids(cls, values):
        return sorted({normalize_student_id(v) for v in values})


def reset_account_password(db, account, password):
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"账号长度不足{MIN_PASSWORD_LENGTH}位，请由管理员设置临时密码")
    account.password_hash = hash_password(password)
    account.must_change_password = True
    db.execute(delete(AuthSession).where(AuthSession.user_id == account.id))


@router.post("/batch")
def batch_students(classroom_id: int, body: BatchInput, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(require_teacher)]):
    own_classroom(db, user, classroom_id, exclusive=True)
    rows = list(db.scalars(select(User).where(User.student_id.in_(body.student_ids)).order_by(User.id).with_for_update()))
    if len(rows) != len(body.student_ids) or any(u.role != "student" or not db.get(Membership, (u.id, classroom_id)) for u in rows):
        raise HTTPException(403, "只能操作当前班级的学生；本次未做任何修改")
    for student in rows:
        if body.action == "reset-password":
            reset_account_password(db, student, student.student_id)
        else:
            db.delete(db.get(Membership, (student.id, classroom_id)))
    db.commit()
    return {"affected": len(rows)}


template_router = APIRouter(tags=["student accounts"])
TEMPLATE_EXAMPLES: tuple[tuple[str, str], ...] = (
    ("20260001", "张三"),
    ("20260002", "李四"),
)


def build_roster_template(fmt: Literal["xlsx", "csv"]) -> tuple[bytes, str, str]:
    if fmt == "csv":
        lines = ["学号,姓名", *(f"{sid},{name}" for sid, name in TEMPLATE_EXAMPLES)]
        payload = ("\ufeff" + "\r\n".join(lines) + "\r\n").encode("utf-8")
        return payload, "text/csv; charset=utf-8", "学生名册导入模板.csv"

    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.title = "学生名册"
    sheet.column_dimensions["A"].width = 18
    sheet.column_dimensions["A"].number_format = "@"
    sheet.column_dimensions["B"].width = 16
    sheet.column_dimensions["B"].number_format = "@"

    header_id = sheet.cell(row=1, column=1, value="学号")
    header_name = sheet.cell(row=1, column=2, value="姓名")
    header_id.number_format = "@"
    header_name.number_format = "@"

    for row_index, (sid, name) in enumerate(TEMPLATE_EXAMPLES, start=2):
        id_cell = sheet.cell(row=row_index, column=1, value=sid)
        name_cell = sheet.cell(row=row_index, column=2, value=name)
        id_cell.data_type = "s"
        id_cell.number_format = "@"
        name_cell.data_type = "s"
        name_cell.number_format = "@"

    # Pre-format all 500 importable rows as Text so leading zeros stay intact in Excel/WPS.
    for row_index in range(len(TEMPLATE_EXAMPLES) + 2, MAX_ROWS + 2):
        sheet.cell(row=row_index, column=1).number_format = "@"
        sheet.cell(row=row_index, column=2).number_format = "@"

    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()
    return (
        buffer.getvalue(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "学生名册导入模板.xlsx",
    )


@template_router.get("/teacher/roster-template")
def roster_template(
    _user: Annotated[User, Depends(require_teacher)],
    fmt: Literal["xlsx", "csv"] = "xlsx",
) -> Response:
    payload, media_type, filename = build_roster_template(fmt)
    ascii_name = f"roster-template.{fmt}"
    encoded = quote(filename)
    headers = {
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}",
    }
    return Response(content=payload, media_type=media_type, headers=headers)
