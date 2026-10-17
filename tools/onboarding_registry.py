#!/usr/bin/env python3
"""Local-only, atomic administrative employee registry. No external services."""
import datetime
import hashlib
import json
import os
import signal
import sqlite3
import sys
import uuid
from pathlib import Path

cancelled = False


def cancel(_signum, _frame):
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, cancel)


def check_cancelled():
    if cancelled:
        raise ValueError('任务已取消，员工登记事务未提交')


def result_for(connection, record, payload_hash):
    matches = connection.execute(
        'SELECT employee_number, work_email_normalized, payload_hash, employee_ref, receipt_id, created_at '
        'FROM employees WHERE employee_number = ? OR (work_email_normalized <> ? AND work_email_normalized = ?)',
        (record['employeeNumber'], '', record['workEmail'].lower())
    ).fetchall()
    if not matches:
        return {'status': 'new'}
    if len(matches) == 1 and matches[0][0] == record['employeeNumber'] and matches[0][2] == payload_hash:
        return {'status': 'existing_identical', 'employeeRef': matches[0][3], 'receiptId': matches[0][4], 'createdAt': matches[0][5]}
    return {'status': 'conflict'}


def validate_message(message):
    if message.get('operation') not in ('check', 'register'):
        raise ValueError('不支持的员工登记操作')
    record = message.get('record')
    if not isinstance(record, dict) or record.get('employmentConfirmed') is not True:
        raise ValueError('尚未确认已完成录用决定')
    for key in ('employeeNumber', 'employeeName', 'department', 'position', 'startDate'):
        if not isinstance(record.get(key), str) or not record[key]:
            raise ValueError('员工原始行政资料缺少必填字段')
    try:
        datetime.date.fromisoformat(record['startDate'])
    except (ValueError, TypeError):
        raise ValueError('入职日期无效')
    if not isinstance(record.get('workEmail'), str):
        raise ValueError('工作邮箱须为文本或空文本')
    if not isinstance(message.get('payloadHash'), str) or len(message['payloadHash']) != 64:
        raise ValueError('资料快照校验失败')
    canonical = json.dumps(record, ensure_ascii=False, separators=(',', ':'))
    if hashlib.sha256(canonical.encode('utf-8')).hexdigest() != message['payloadHash']:
        raise ValueError('资料快照校验失败')
    registry_path = Path(message.get('registryPath', ''))
    expected = 'example-registry.sqlite' if message.get('isExample') is True else 'employee-registry.sqlite'
    if not registry_path.is_absolute() or registry_path.name != expected or registry_path.parent.name != 'hr':
        raise ValueError('员工登记册位置无效')
    return record, canonical, registry_path


def main(message):
    record, canonical, registry_path = validate_message(message)
    check_cancelled()
    if message['operation'] == 'check':
        if not registry_path.exists():
            return {'status': 'new'}
        connection = sqlite3.connect(registry_path.as_uri() + '?mode=ro', uri=True, timeout=10)
        try:
            check_cancelled()
            # A cancelled first transaction can leave an empty but valid SQLite file.
            # Treat this as an empty registry, then recreate the schema atomically at registration.
            if not connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'employees'").fetchone():
                return {'status': 'new'}
            return result_for(connection, record, message['payloadHash'])
        finally:
            connection.close()
    registry_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    connection = sqlite3.connect(str(registry_path), timeout=10, isolation_level=None)
    try:
        # Restrict the local HR master to the current OS account.
        os.chmod(str(registry_path), 0o600)
        connection.execute('PRAGMA busy_timeout = 10000')
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('CREATE TABLE IF NOT EXISTS employees ('
                           'employee_number TEXT PRIMARY KEY, work_email_normalized TEXT NOT NULL, '
                           'payload_hash TEXT NOT NULL, employee_ref TEXT UNIQUE NOT NULL, '
                           'receipt_id TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL, created_at TEXT NOT NULL)')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS unique_nonempty_work_email '
                           'ON employees(work_email_normalized) WHERE work_email_normalized <> \'\'')
        check_cancelled()
        existing = result_for(connection, record, message['payloadHash'])
        if existing['status'] == 'conflict':
            raise ValueError('工号或工作邮箱与既有登记冲突，未覆盖或修改原记录')
        if existing['status'] == 'existing_identical':
            connection.execute('COMMIT')
            return existing
        receipt_id = str(uuid.uuid4())
        created_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        connection.execute('INSERT INTO employees '
                           '(employee_number, work_email_normalized, payload_hash, employee_ref, receipt_id, record_json, created_at) '
                           'VALUES (?, ?, ?, ?, ?, ?, ?)',
                           (record['employeeNumber'], record['workEmail'].lower(), message['payloadHash'],
                            message['employeeRef'], receipt_id, canonical, created_at))
        check_cancelled()
        connection.execute('COMMIT')
        return {'status': 'inserted', 'employeeRef': message['employeeRef'], 'receiptId': receipt_id, 'createdAt': created_at}
    except BaseException:
        if connection.in_transaction:
            connection.execute('ROLLBACK')
        raise
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        answer = main(request)
        print(json.dumps({'ok': True, 'result': answer}, ensure_ascii=False))
    except Exception as error:
        # SQLite errors must not echo raw employee values or raw SQL parameters.
        safe_error = str(error) if isinstance(error, ValueError) else '本地员工登记册不可用，未确认登记结果，请查阅本地记录后重试'
        print(json.dumps({'ok': False, 'error': safe_error}, ensure_ascii=False))
