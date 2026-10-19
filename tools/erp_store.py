#!/usr/bin/env python3
"""Transactional single-company ERP ledger. All SQL values are parameters.

No model response can post inventory, approve a request, or assign a performance
score. The internal agent_result operation stores an attributed draft only.
"""
import datetime
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import uuid
from pathlib import Path

ROLES = {'admin', 'manager', 'procurement', 'warehouse', 'project_manager', 'employee', 'finance', 'hr'}
CHAINS = {
    'project_setup': ['project_manager', 'manager'],
    'project_delivery': ['project_manager', 'manager'],
    'purchase': ['manager', 'finance'], 'sales': ['manager', 'finance'],
    'stocktake': ['manager', 'finance'], 'resource': ['manager', 'warehouse'],
    'weekly_report': ['project_manager', 'manager'], 'onboarding': ['hr', 'manager'],
}
LABELS = {'project_setup': '项目立项', 'project_delivery': '任务交付验收', 'purchase': '项目采购', 'sales': '销售发货', 'stocktake': '库存盘点', 'resource': '资源借用归还', 'weekly_report': '项目周报与贡献核对', 'onboarding': '员工岗位资源准备'}


class DomainError(Exception):
    def __init__(self, message, code='VALIDATION', status=400):
        super().__init__(message)
        self.code, self.status = code, status


def fail(message, code='VALIDATION', status=400):
    raise DomainError(message, code, status)


def text(value, label, maximum=500, required=True):
    if value is None and not required:
        return ''
    if not isinstance(value, str):
        fail(label + '须为文本')
    value = value.strip()
    if (required and not value) or len(value) > maximum or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', value):
        fail(label + '为空、过长或含无效字符')
    return value


def integer(value, label, minimum=1, maximum=1000000000):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        fail(label + '须为范围内的整数')
    return value


def date(value, label, required=False):
    value = text(value, label, 10, required)
    if value:
        try:
            if datetime.date.fromisoformat(value).isoformat() != value:
                raise ValueError()
        except ValueError:
            fail(label + '须为有效日期YYYY-MM-DD')
    return value


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def uid(prefix):
    return prefix + '-' + str(uuid.uuid4())


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)


def actor_for(value):
    if not isinstance(value, dict):
        fail('请先登录员工账号', 'UNAUTHORIZED', 401)
    roles = value.get('roles', [])
    if not isinstance(roles, list) or not roles or any(r not in ROLES for r in roles):
        fail('员工岗位权限无效', 'FORBIDDEN', 403)
    return {'id': text(value.get('id'), '员工编号', 100), 'roles': roles,
            'department': text(value.get('department', ''), '部门', 100, False),
            'displayName': text(value.get('displayName', value.get('id')), '员工姓名', 100)}


def require_role(actor, roles):
    if 'admin' not in actor['roles'] and not set(actor['roles']).intersection(roles):
        fail('当前岗位不能办理此操作', 'FORBIDDEN', 403)


SCHEMA = '''
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,sku TEXT UNIQUE NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(price_cents>=0),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,customer TEXT NOT NULL,owner_id TEXT NOT NULL,department TEXT NOT NULL,members_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,project_id TEXT REFERENCES projects(id),requester_id TEXT NOT NULL,department TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,input_json TEXT NOT NULL,proposal_json TEXT,evidence_json TEXT NOT NULL,agent_run_id TEXT,approval_index INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,approval_round INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS document_lines(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),product_id TEXT NOT NULL REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>=0),unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),completed_quantity INTEGER NOT NULL DEFAULT 0 CHECK(completed_quantity>=0),system_quantity INTEGER NOT NULL DEFAULT 0,system_movement_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),stage INTEGER NOT NULL,role TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,decision TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,round INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS document_history(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),version INTEGER NOT NULL,round INTEGER NOT NULL,snapshot_json TEXT NOT NULL,revised_by TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_results(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),round INTEGER NOT NULL,run_id TEXT NOT NULL,proposal_json TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,run_id));
CREATE TABLE IF NOT EXISTS inventory(product_id TEXT PRIMARY KEY REFERENCES products(id),quantity INTEGER NOT NULL CHECK(quantity>=0));
CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),line_id TEXT NOT NULL REFERENCES document_lines(id),product_id TEXT NOT NULL REFERENCES products(id),delta INTEGER NOT NULL,balance INTEGER NOT NULL CHECK(balance>=0),kind TEXT NOT NULL,reference TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),kind TEXT NOT NULL,reference TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,kind,reference));
CREATE TABLE IF NOT EXISTS loans(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),product_id TEXT NOT NULL REFERENCES products(id),employee_id TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),returned_quantity INTEGER NOT NULL DEFAULT 0 CHECK(returned_quantity>=0),CHECK(returned_quantity<=quantity));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,assignee_id TEXT NOT NULL,created_by TEXT NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT,submitted_at TEXT,accepted_by TEXT);
CREATE TABLE IF NOT EXISTS task_events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),action TEXT NOT NULL,actor_id TEXT NOT NULL,result TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS performance(id TEXT PRIMARY KEY,document_id TEXT UNIQUE NOT NULL REFERENCES documents(id),project_id TEXT NOT NULL REFERENCES projects(id),period_start TEXT NOT NULL,period_end TEXT NOT NULL,facts_json TEXT NOT NULL,confirmed_by TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,entity_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(actor_id TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(actor_id,key));
CREATE INDEX IF NOT EXISTS document_project_idx ON documents(project_id);
CREATE INDEX IF NOT EXISTS movement_document_idx ON movements(document_id);
CREATE INDEX IF NOT EXISTS task_project_idx ON tasks(project_id);
'''


def project_for(c, project_id):
    row = c.execute('SELECT * FROM projects WHERE id=?', (project_id,)).fetchone()
    if row is None:
        fail('项目不存在', 'NOT_FOUND', 404)
    result = dict(row)
    result['ownerId'] = result.pop('owner_id')
    result['members'] = json.loads(result.pop('members_json'))
    result['createdAt'] = result.pop('created_at')
    return result


def project_access(actor, project):
    return ('admin' in actor['roles'] or project['ownerId'] == actor['id'] or actor['id'] in project['members'] or
            ('manager' in actor['roles'] and bool(actor['department']) and project['department'] == actor['department']))


def check_project(c, actor, project_id):
    project = project_for(c, project_id)
    if not project_access(actor, project):
        fail('你不是此项目成员或所属部门负责人', 'FORBIDDEN', 403)
    return project


def document_access(c, actor, row):
    if 'admin' in actor['roles'] or row['requester_id'] == actor['id']:
        return True
    # Business operators need membership for project documents; company-level
    # requests are visible to the responsible approval/handling roles only.
    if row['project_id']:
        return project_access(actor, project_for(c, row['project_id']))
    responsible = set(actor['roles']).intersection(set(CHAINS[row['type']]) | {'warehouse'})
    if responsible - {'manager'}:
        return True
    return 'manager' in responsible and bool(actor['department']) and actor['department'] == row['department']


def raw_document(c, document_id, actor=None):
    row = c.execute('SELECT * FROM documents WHERE id=?', (document_id,)).fetchone()
    if row is None:
        fail('业务单据不存在', 'NOT_FOUND', 404)
    if actor is not None and not document_access(c, actor, row):
        fail('没有此单据的访问权限', 'FORBIDDEN', 403)
    return row


def approvals_for(c, doc, historical=False):
    sql = 'SELECT stage,role,actor_id AS actorId,actor_name AS actorName,decision,note,created_at AS createdAt,round FROM approvals WHERE document_id=?'
    params = [doc['id']]
    if not historical:
        sql += ' AND round=?'
        params.append(doc['approval_round'])
    recorded = [dict(r) for r in c.execute(sql + ' ORDER BY created_at,id', params)]
    return recorded


def actions_for(c, actor, doc):
    if actor is None:
        return []
    result = []
    status = doc['status']
    if status in ('draft', 'rejected') and (doc['requester_id'] == actor['id'] or 'admin' in actor['roles']):
        result += ['revise']
    if status == 'draft' and (doc['requester_id'] == actor['id'] or 'admin' in actor['roles']):
        result += ['run_agents']
        if doc['agent_run_id']:
            result += ['submit']
    if status == 'awaiting_approval':
        role = CHAINS[doc['type']][doc['approval_index']]
        prior = {a['actorId'] for a in approvals_for(c, doc) if a['decision'] == 'approved'}
        if doc['requester_id'] != actor['id'] and actor['id'] not in prior and ('admin' in actor['roles'] or role in actor['roles']):
            result += ['approve', 'reject']
    if status in ('approved', 'partially_received', 'partially_shipped'):
        if doc['type'] == 'purchase' and set(actor['roles']).intersection({'warehouse', 'admin'}):
            result += ['receive']
        elif doc['type'] == 'sales' and set(actor['roles']).intersection({'warehouse', 'admin'}):
            result += ['ship']
        elif doc['type'] not in ('purchase', 'sales'):
            required = {'warehouse'} if doc['type'] in ('stocktake', 'resource') else {'project_manager', 'manager', 'hr'}
            if set(actor['roles']).intersection(required | {'admin'}):
                result += ['post']
    return result


def document_for(c, document_id, actor=None):
    row = raw_document(c, document_id, actor)
    result = {'id': row['id'], 'type': row['type'], 'workflowId': row['type'], 'title': row['title'], 'projectId': row['project_id'],
              'requesterId': row['requester_id'], 'department': row['department'], 'status': row['status'], 'version': row['version'],
              'input': json.loads(row['input_json']), 'proposal': json.loads(row['proposal_json']) if row['proposal_json'] else None,
              'evidence': json.loads(row['evidence_json']), 'agentRunId': row['agent_run_id'], 'approvalIndex': row['approval_index'],
              'approvalChain': CHAINS[row['type']], 'approvals': approvals_for(c, row), 'approvalRound': row['approval_round'], 'approvalHistory': approvals_for(c, row, True), 'createdAt': row['created_at'], 'updatedAt': row['updated_at']}
    result['lines'] = [dict(r) for r in c.execute('SELECT l.id,l.product_id AS productId,p.sku,p.name,p.unit,l.quantity,l.unit_price_cents AS unitPriceCents,l.completed_quantity AS completedQuantity,l.system_quantity AS systemQuantity FROM document_lines l JOIN products p ON p.id=l.product_id WHERE l.document_id=? ORDER BY l.rowid', (document_id,))]
    result['allowedActions'] = actions_for(c, actor, row)
    result['revisions'] = [dict(r) for r in c.execute('SELECT id,version,round,revised_by AS revisedBy,created_at AS createdAt FROM document_history WHERE document_id=? ORDER BY rowid', (document_id,))]
    result['agentHistory'] = [dict(r) for r in c.execute('SELECT round,run_id AS runId,created_at AS createdAt FROM agent_results WHERE document_id=? ORDER BY rowid', (document_id,))]
    return result


def audit(c, actor_id, action, entity_id, detail=None):
    c.execute('INSERT INTO audit VALUES(?,?,?,?,?,?)', (uid('AUD'), actor_id, action, entity_id, dump(detail or {}), now()))


def balance(c, product_id):
    r = c.execute('SELECT quantity FROM inventory WHERE product_id=?', (product_id,)).fetchone()
    return r['quantity'] if r else 0


def stock_revision(c, product_id):
    row = c.execute('SELECT id FROM movements WHERE product_id=? ORDER BY rowid DESC LIMIT 1', (product_id,)).fetchone()
    return row['id'] if row else ''


def move(c, actor, doc, line, delta, kind, reference):
    require_active_project(c, doc['project_id'])
    current = balance(c, line['product_id'])
    updated = current + delta
    if updated < 0:
        fail('库存不足，未产生任何出库流水', 'STOCK_SHORTAGE', 409)
    integer(updated, '库存余额', 0)
    c.execute('INSERT INTO inventory(product_id,quantity) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET quantity=excluded.quantity', (line['product_id'], updated))
    c.execute('INSERT INTO movements VALUES(?,?,?,?,?,?,?,?,?,?)', (uid('MOV'), doc['id'], line['id'], line['product_id'], delta, updated, kind, reference, actor['id'], now()))


def require_active_project(c, project_id):
    if project_id and project_for(c, project_id)['status'] != 'active':
        fail('请先完成项目立项审批并确认启用，再办理实际交付或库存流转', 'PROJECT_NOT_ACTIVE', 409)


def validate_input(doc_type, raw):
    if not isinstance(raw, dict):
        fail('业务资料须为对象')
    result = {}
    if doc_type in ('purchase', 'sales'):
        result['partner'] = text(raw.get('partner'), '供应商或客户', 200)
        result['expectedDate'] = date(raw.get('expectedDate'), '预计日期')
        if doc_type == 'purchase':
            for key, label, limit in [('quotationReference', '供应商报价凭证或链接', 1000), ('quotationNotes', '供应商报价依据与条件', 4000)]:
                value = text(raw.get(key, ''), label, limit, False)
                if value:
                    result[key] = value
    elif doc_type == 'project_setup':
        result['objective'] = text(raw.get('objective'), '项目目标', 4000)
        result['expectedDate'] = date(raw.get('expectedDate'), '预计日期')
    elif doc_type == 'project_delivery':
        result['acceptanceCriteria'] = text(raw.get('acceptanceCriteria'), '验收标准', 4000)
        result['deliveryNote'] = text(raw.get('deliveryNote'), '交付说明', 8000)
    elif doc_type == 'resource':
        if raw.get('operation') not in ('issue', 'return'):
            fail('资源操作须为借出或归还')
        result = {'operation': raw['operation'], 'employeeId': text(raw.get('employeeId'), '领用员工', 100), 'purpose': text(raw.get('purpose'), '物品用途', 2000)}
        if raw['operation'] == 'return':
            result['originalDocumentId'] = text(raw.get('originalDocumentId'), '原借出单号', 100)
        if raw.get('sourceOnboardingDocumentId'):
            result['sourceOnboardingDocumentId'] = text(raw['sourceOnboardingDocumentId'], '岗位准备单号', 100)
    elif doc_type == 'weekly_report':
        result = {'periodStart': date(raw.get('periodStart'), '开始日期', True), 'periodEnd': date(raw.get('periodEnd'), '结束日期', True), 'summary': text(raw.get('summary', ''), '周报说明', 8000, False)}
        if result['periodStart'] > result['periodEnd']:
            fail('周报结束日期不能早于开始日期')
    elif doc_type == 'onboarding':
        result = {'employeeId': text(raw.get('employeeId'), '入驻员工', 100), 'position': text(raw.get('position'), '岗位', 100),
                  'resourceRequirements': text(raw.get('resourceRequirements'), '岗位资源需求', 4000)}
    elif doc_type == 'stocktake':
        result = {'note': text(raw.get('note'), '盘点原因及依据', 4000)}
    return result


def prepare_document(c, actor, payload):
    doc_type = payload.get('type')
    if doc_type not in CHAINS:
        fail('不支持的业务流程')
    if doc_type == 'stocktake':
        require_role(actor, {'warehouse', 'manager'})
    if doc_type == 'onboarding':
        require_role(actor, {'hr', 'manager'})
    project_id = text(payload.get('projectId'), '项目编号', 100, False) or None
    if doc_type in ('project_setup', 'project_delivery', 'weekly_report') and not project_id:
        fail('此流程必须关联项目')
    if project_id:
        project = check_project(c, actor, project_id)
        if doc_type == 'project_setup' and project['status'] != 'draft':
            fail('项目已启用，不必重复立项', 'STATE_CONFLICT', 409)
    details = validate_input(doc_type, payload.get('input', {}))
    if doc_type == 'resource' and details.get('sourceOnboardingDocumentId'):
        source = raw_document(c, details['sourceOnboardingDocumentId'], actor)
        source_input = json.loads(source['input_json'])
        if source['type'] != 'onboarding' or source['status'] != 'completed' or source_input.get('employeeId') != details['employeeId']:
            fail('岗位准备来源须为同一员工已完成且有权查看的准备单', 'INVALID_SOURCE', 409)
    if doc_type == 'weekly_report':
        details['facts'] = weekly_facts(c, project_id, details['periodStart'], details['periodEnd'])
    raw_lines = payload.get('lines', [])
    if not isinstance(raw_lines, list) or len(raw_lines) > 100:
        fail('产品明细最多100行')
    if doc_type in ('purchase', 'sales', 'stocktake', 'resource') and not raw_lines:
        fail('请至少填写一项产品明细')
    if doc_type not in ('purchase', 'sales', 'stocktake', 'resource') and raw_lines:
        fail('此流程不接受库存明细')
    lines, seen = [], set()
    for item in raw_lines:
        if not isinstance(item, dict):
            fail('产品明细须为对象')
        pid = text(item.get('productId'), '产品编号', 100)
        if pid in seen:
            fail('同一产品请合并为一行')
        seen.add(pid)
        product = c.execute('SELECT * FROM products WHERE id=?', (pid,)).fetchone()
        if product is None:
            fail('产品不存在', 'NOT_FOUND', 404)
        qty = integer(item.get('countedQuantity') if doc_type == 'stocktake' else item.get('quantity'), '产品数量', 0 if doc_type == 'stocktake' else 1)
        price = integer(item.get('unitPriceCents', product['price_cents']), '单价分', 0, 1000000000000)
        if qty * price > 9007199254740991:
            fail('单据金额超过安全整数范围')
        lines.append((uid('LIN'), pid, qty, price, balance(c, pid), stock_revision(c, pid)))
    if sum(line[2] * line[3] for line in lines) > 9007199254740991:
        fail('单据总金额超过安全整数范围')
    if doc_type == 'resource' and details['operation'] == 'return':
        original = raw_document(c, details['originalDocumentId'], actor)
        original_input = json.loads(original['input_json'])
        if original['type'] != 'resource' or original_input.get('operation') != 'issue' or original['status'] != 'completed' or original_input.get('employeeId') != details['employeeId']:
            fail('归还单必须对应同一员工的已完成借出单')
        if original['project_id'] != project_id:
            fail('归还单与原借出单的项目必须一致')
        for _, pid, qty, _, _, _ in lines:
            loan = c.execute('SELECT * FROM loans WHERE document_id=? AND product_id=?', (original['id'], pid)).fetchone()
            if loan is None or qty > loan['quantity'] - loan['returned_quantity']:
                fail('归还数量超过未归还数量', 'OVER_RETURN', 409)
    return doc_type, project_id, details, lines


def create_document(c, actor, payload):
    doc_type, project_id, details, lines = prepare_document(c, actor, payload)
    did, timestamp = uid('DOC'), now()
    c.execute('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (did, doc_type, text(payload.get('title', LABELS[doc_type]), '单据名称', 200), project_id, actor['id'], actor['department'], 'draft', 1, dump(details), None, '[]', None, 0, timestamp, timestamp, 1))
    for lid, pid, qty, price, system_qty, revision in lines:
        c.execute('INSERT INTO document_lines VALUES(?,?,?,?,?,?,?,?)', (lid, did, pid, qty, price, 0, system_qty, revision))
    audit(c, actor['id'], 'document.create', did, {'type': doc_type})
    return document_for(c, did, actor)


def revise_document(c, actor, doc, payload):
    if doc['requester_id'] != actor['id'] and 'admin' not in actor['roles']:
        fail('只有申请人或管理员能修订资料', 'FORBIDDEN', 403)
    if doc['status'] not in ('draft', 'rejected'):
        fail('审批中或已批准、已入账的单据不能修订', 'STATE_CONFLICT', 409)
    if 'type' in payload and payload['type'] != doc['type']:
        fail('修订不能更换业务流程')
    if 'projectId' in payload and (payload['projectId'] or None) != doc['project_id']:
        fail('修订不能更换所属项目，请另建申请')
    current = document_for(c, doc['id'], actor)
    lines = [{'productId': l['productId'], 'countedQuantity' if doc['type'] == 'stocktake' else 'quantity': l['quantity'], 'unitPriceCents': l['unitPriceCents']} for l in current['lines']]
    merged = {'type': doc['type'], 'projectId': doc['project_id'], 'title': payload.get('title', doc['title']), 'input': payload.get('input', current['input']), 'lines': payload.get('lines', lines)}
    _, _, details, lines = prepare_document(c, actor, merged)
    title = text(merged['title'], '单据名称', 200)
    c.execute('INSERT INTO document_history VALUES(?,?,?,?,?,?,?)', (uid('REV'), doc['id'], doc['version'], doc['approval_round'], dump(current), actor['id'], now()))
    # A rejected/draft request cannot have accounting postings, nevertheless
    # verify this invariant before replacing any line identifiers.
    if c.execute('SELECT 1 FROM movements WHERE document_id=? LIMIT 1', (doc['id'],)).fetchone():
        fail('已有库存流水的单据不能修订', 'STATE_CONFLICT', 409)
    c.execute('DELETE FROM document_lines WHERE document_id=?', (doc['id'],))
    for lid, pid, qty, price, system_qty, revision in lines:
        c.execute('INSERT INTO document_lines VALUES(?,?,?,?,?,?,?,?)', (lid, doc['id'], pid, qty, price, 0, system_qty, revision))
    c.execute("UPDATE documents SET title=?,input_json=?,status='draft',proposal_json=NULL,evidence_json='[]',agent_run_id=NULL,approval_index=0,approval_round=approval_round+1,version=version+1,updated_at=? WHERE id=?", (title, dump(details), now(), doc['id']))
    audit(c, actor['id'], 'document.revise', doc['id'], {'fromVersion': doc['version'], 'fromRound': doc['approval_round'], 'toRound': doc['approval_round'] + 1, 'previousStatus': doc['status']})
    return document_for(c, doc['id'], actor)


def update_document(c, doc, status, **values):
    # Column names are internal constants, never derived from input.
    allowed = {'approval_index', 'proposal_json', 'evidence_json', 'agent_run_id'}
    if set(values) - allowed:
        fail('无效的内部字段')
    assignments, params = ['status=?', 'version=version+1', 'updated_at=?'], [status, now()]
    for key, value in values.items():
        assignments.append(key + '=?')
        params.append(value)
    params.append(doc['id'])
    c.execute('UPDATE documents SET ' + ','.join(assignments) + ' WHERE id=?', params)


def process_receipt(c, actor, doc, payload, kind):
    require_role(actor, {'warehouse'})
    required_type = 'purchase' if kind == 'receive' else 'sales'
    allowed = ('approved', 'partially_received') if kind == 'receive' else ('approved', 'partially_shipped')
    if doc['type'] != required_type or doc['status'] not in allowed:
        fail('当前单据不能办理此收发货操作', 'STATE_CONFLICT', 409)
    reference = text(payload.get('reference'), '真实收发货凭证号', 150)
    if c.execute('SELECT 1 FROM receipts WHERE document_id=? AND kind=? AND reference=?', (doc['id'], kind, reference)).fetchone():
        fail('该收发货凭证已登记，请勿重复入账', 'DUPLICATE_RECEIPT', 409)
    items = payload.get('lines')
    if not isinstance(items, list) or not items or len(items) > 100:
        fail('请填写本次实际收发货数量')
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            fail('收发货明细须为对象')
        lid = text(item.get('lineId'), '明细编号', 100)
        if lid in seen:
            fail('同一明细不能重复提交')
        seen.add(lid)
        line = c.execute('SELECT * FROM document_lines WHERE id=? AND document_id=?', (lid, doc['id'])).fetchone()
        if line is None:
            fail('收发货明细不属于此单据')
        qty = integer(item.get('quantity'), '本次实际数量')
        if qty > line['quantity'] - line['completed_quantity']:
            fail('数量超过单据剩余未办理数量', 'OVER_FULFILMENT', 409)
        move(c, actor, doc, line, qty if kind == 'receive' else -qty, kind, reference)
        c.execute('UPDATE document_lines SET completed_quantity=completed_quantity+? WHERE id=?', (qty, lid))
    c.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?)', (uid('REC'), doc['id'], kind, reference, actor['id'], now()))
    remaining = c.execute('SELECT SUM(quantity-completed_quantity) FROM document_lines WHERE document_id=?', (doc['id'],)).fetchone()[0]
    update_document(c, doc, 'completed' if remaining == 0 else ('partially_received' if kind == 'receive' else 'partially_shipped'))


def post_document(c, actor, doc, payload):
    if doc['status'] != 'approved' or doc['type'] in ('purchase', 'sales'):
        fail('当前单据尚不能确认完成', 'STATE_CONFLICT', 409)
    details, lines = json.loads(doc['input_json']), list(c.execute('SELECT * FROM document_lines WHERE document_id=?', (doc['id'],)))
    if doc['type'] in ('resource', 'stocktake'):
        require_role(actor, {'warehouse'})
        reference = text(payload.get('reference'), '实际办理凭证号', 150)
        if doc['type'] == 'stocktake':
            for line in lines:
                if balance(c, line['product_id']) != line['system_quantity'] or stock_revision(c, line['product_id']) != line['system_movement_id']:
                    fail('盘点后库存已有变动，请重新盘点后发起调整', 'STALE_STOCKTAKE', 409)
            for line in lines:
                move(c, actor, doc, line, line['quantity'] - line['system_quantity'], 'stocktake', reference)
        elif details['operation'] == 'issue':
            for line in lines:
                move(c, actor, doc, line, -line['quantity'], 'resource_issue', reference)
                c.execute('INSERT INTO loans VALUES(?,?,?,?,?,?)', (uid('LOAN'), doc['id'], line['product_id'], details['employeeId'], line['quantity'], 0))
        else:
            for line in lines:
                loan = c.execute('SELECT * FROM loans WHERE document_id=? AND product_id=? AND employee_id=?', (details['originalDocumentId'], line['product_id'], details['employeeId'])).fetchone()
                if loan is None or line['quantity'] > loan['quantity'] - loan['returned_quantity']:
                    fail('归还数量超过当前未归还数量', 'OVER_RETURN', 409)
                move(c, actor, doc, line, line['quantity'], 'resource_return', reference)
                c.execute('UPDATE loans SET returned_quantity=returned_quantity+? WHERE id=?', (line['quantity'], loan['id']))
        c.execute('UPDATE document_lines SET completed_quantity=quantity WHERE document_id=?', (doc['id'],))
    else:
        require_role(actor, {'manager', 'project_manager', 'hr'})
        if doc['type'] == 'project_setup':
            if project_for(c, doc['project_id'])['status'] != 'draft':
                fail('项目已由其他立项单启用', 'STATE_CONFLICT', 409)
            c.execute("UPDATE projects SET status='active' WHERE id=?", (doc['project_id'],))
        elif doc['type'] == 'weekly_report':
            require_active_project(c, doc['project_id'])
            facts = details['facts']
            c.execute('INSERT INTO performance VALUES(?,?,?,?,?,?,?,?)', (uid('PERF'), doc['id'], doc['project_id'], details['periodStart'], details['periodEnd'], dump(facts), actor['id'], now()))
        elif doc['type'] == 'project_delivery':
            require_active_project(c, doc['project_id'])
    update_document(c, doc, 'completed')


def business_date(value):
    if not value:
        return ''
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()


def weekly_facts(c, project_id, start, end):
    tasks = [dict(r) for r in c.execute("SELECT id,title,assignee_id AS employeeId,completed_at AS completedAt,accepted_by AS acceptedBy FROM tasks WHERE project_id=? AND status='completed' AND accepted_by IS NOT NULL AND date(completed_at,'+8 hours')>=? AND date(completed_at,'+8 hours')<=? ORDER BY completed_at,id", (project_id, start, end))]
    people, task_facts = {}, []
    def person(employee_id):
        return people.setdefault(employee_id, {'employeeId': employee_id, 'assignedTasks': 0, 'submittedTasks': 0, 'pendingTasks': 0, 'overdueTasks': 0, 'completedTasks': 0, 'acceptedDeliveries': 0, 'businessParticipation': 0, 'taskIds': [], 'assignedTaskIds': [], 'submittedTaskIds': [], 'pendingTaskIds': [], 'overdueTaskIds': [], 'acceptedDeliveryIds': [], 'businessDocumentIds': []})
    for task in tasks:
        employee = person(task['employeeId'])
        employee['completedTasks'] += 1
        employee['taskIds'].append(task['id'])
    for task in c.execute('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at,id', (project_id,)):
        if business_date(task['created_at']) > end:
            continue
        events = [dict(r) for r in c.execute('SELECT * FROM task_events WHERE task_id=? ORDER BY rowid', (task['id'],))]
        reassignments = [e for e in events if e['action'] == 'reassigned']
        original_assignee = json.loads(reassignments[0]['evidence_json'])[0]['before']['assigneeId'] if reassignments else task['assignee_id']
        assignments = [(original_assignee, task['created_at'])]
        current_assignee, state = original_assignee, 'pending'
        submitted = set()
        for event in events:
            event_date = business_date(event['created_at'])
            if event['action'] == 'reassigned':
                assigned_to = json.loads(event['evidence_json'])[0]['after']['assigneeId']
                assignments.append((assigned_to, event['created_at']))
            if start <= event_date <= end and event['action'] == 'submitted':
                submitted.add(event['actor_id'])
            if event_date <= end:
                if event['action'] == 'reassigned':
                    current_assignee, state = assigned_to, 'pending'
                elif event['action'] in ('submitted', 'returned', 'accepted'):
                    state = {'submitted': 'submitted', 'returned': 'pending', 'accepted': 'completed'}[event['action']]
        # Older data can contain submitted_at without a task event. This is
        # submission evidence only, never independent acceptance.
        if not any(e['action'] == 'submitted' for e in events) and task['submitted_at']:
            submitted_date = business_date(task['submitted_at'])
            if start <= submitted_date <= end:
                submitted.add(current_assignee)
            if submitted_date <= end and state == 'pending':
                state = 'submitted'
        if task['status'] == 'completed' and task['accepted_by'] and business_date(task['completed_at']) <= end:
            state = 'completed'
        assigned_people = {employee_id for employee_id, assigned_at in assignments if start <= business_date(assigned_at) <= end}
        for employee_id in assigned_people:
            person(employee_id)['assignedTaskIds'].append(task['id'])
        for employee_id in submitted:
            person(employee_id)['submittedTaskIds'].append(task['id'])
        pending = state != 'completed'
        overdue = pending and bool(task['due_date']) and task['due_date'] <= end
        if pending:
            person(current_assignee)['pendingTaskIds'].append(task['id'])
        if overdue:
            person(current_assignee)['overdueTaskIds'].append(task['id'])
        task_facts.append({'id': task['id'], 'title': task['title'], 'assigneeIdAtPeriodEnd': current_assignee, 'stateAtPeriodEnd': state, 'dueDate': task['due_date'], 'assignedEmployeeIds': sorted(assigned_people), 'submittedEmployeeIds': sorted(submitted), 'overdueAtPeriodEnd': overdue})
    confirmed = []
    for doc in c.execute("SELECT id,type,title,requester_id,updated_at FROM documents WHERE project_id=? AND status='completed' AND date(updated_at,'+8 hours')>=? AND date(updated_at,'+8 hours')<=? ORDER BY updated_at,id", (project_id, start, end)):
        participants = {doc['requester_id']}
        participants.update(r['actor_id'] for r in c.execute("SELECT actor_id FROM approvals WHERE document_id=? AND decision='approved' AND round=(SELECT approval_round FROM documents WHERE id=?)", (doc['id'], doc['id'])))
        participants.update(r['actor_id'] for r in c.execute('SELECT actor_id FROM movements WHERE document_id=?', (doc['id'],)))
        participants.update(r['actor_id'] for r in c.execute("SELECT actor_id FROM audit WHERE entity_id=? AND action='document.post'", (doc['id'],)))
        for employee_id in participants:
            person(employee_id)['businessDocumentIds'].append(doc['id'])
        if doc['type'] == 'project_delivery':
            person(doc['requester_id'])['acceptedDeliveryIds'].append(doc['id'])
        confirmed.append({'id': doc['id'], 'type': doc['type'], 'title': doc['title'], 'completedAt': doc['updated_at'], 'requesterId': doc['requester_id'], 'participantIds': sorted(participants)})
    for employee in people.values():
        for metric, ids in [('assignedTasks', 'assignedTaskIds'), ('submittedTasks', 'submittedTaskIds'), ('pendingTasks', 'pendingTaskIds'), ('overdueTasks', 'overdueTaskIds'), ('acceptedDeliveries', 'acceptedDeliveryIds'), ('businessParticipation', 'businessDocumentIds')]:
            employee[metric] = len(set(employee[ids]))
    return {'assignedTasks': len({t['id'] for t in task_facts if t['assignedEmployeeIds']}), 'submittedTasks': len({t['id'] for t in task_facts if t['submittedEmployeeIds']}), 'pendingTasks': len([t for t in task_facts if t['stateAtPeriodEnd'] != 'completed']), 'overdueTasks': len([t for t in task_facts if t['overdueAtPeriodEnd']]), 'completedTasks': len(tasks), 'acceptedDeliveries': len([d for d in confirmed if d['type'] == 'project_delivery']), 'businessParticipation': len(confirmed), 'tasks': tasks, 'taskFacts': task_facts, 'businessDocuments': confirmed, 'employees': list(people.values()), 'scoresAssigned': False, 'timezone': 'Asia/Shanghai', 'basis': '分配与提交按期间内事实去重；验收按真实负责人确认日期；待办及逾期按北京时间期末日结束统计，含待验收；交付归属原申请人，业务参与按已完成单据去重，人员间可重叠。截止生成时冻结，不生成工时、收入归属、评分或排名。'}


def command(c, actor, action, payload):
    if not isinstance(payload, dict):
        fail('请求资料须为对象')
    if action == 'product.create':
        require_role(actor, {'procurement', 'warehouse', 'manager'})
        pid, timestamp = uid('PRD'), now()
        sku = text(payload.get('sku'), '产品编码', 80)
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', sku):
            fail('产品编码仅支持字母、数字、点、短横线和下划线')
        c.execute('INSERT INTO products VALUES(?,?,?,?,?,?)', (pid, sku, text(payload.get('name'), '产品名称', 200), text(payload.get('unit', '件'), '单位', 30), integer(payload.get('priceCents', 0), '参考单价分', 0, 1000000000000), timestamp))
        audit(c, actor['id'], action, pid)
        return dict(c.execute('SELECT id,sku,name,unit,price_cents AS priceCents,created_at AS createdAt FROM products WHERE id=?', (pid,)).fetchone())
    if action == 'project.create':
        require_role(actor, {'project_manager', 'manager'})
        pid, timestamp = uid('PROJ'), now()
        members = payload.get('members', [])
        if not isinstance(members, list) or len(members) > 200:
            fail('项目成员最多200人')
        members = sorted(set(text(m, '成员编号', 100) for m in members))
        owner = text(payload.get('ownerId', actor['id']), '项目负责人', 100)
        if owner != actor['id'] and 'admin' not in actor['roles'] and 'manager' not in actor['roles']:
            fail('只能创建自己负责的项目', 'FORBIDDEN', 403)
        if actor['id'] not in members:
            members.append(actor['id'])
        if owner not in members:
            members.append(owner)
        c.execute('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)', (pid, text(payload.get('name'), '项目名称', 200), text(payload.get('customer'), '客户', 200), owner, actor['department'], dump(members), 'draft', timestamp))
        audit(c, actor['id'], action, pid)
        return project_for(c, pid)
    if action == 'project.update':
        pid = text(payload.get('id'), '项目编号', 100)
        project = check_project(c, actor, pid)
        if project['ownerId'] != actor['id']:
            require_role(actor, {'manager'})
        members = payload.get('members', project['members'])
        if not isinstance(members, list) or len(members) > 200:
            fail('项目成员最多200人')
        members = sorted(set(text(m, '成员编号', 100) for m in members))
        owner = text(payload.get('ownerId', project['ownerId']), '项目负责人', 100)
        if owner not in members:
            fail('新项目负责人必须在本项目成员中')
        name = text(payload.get('name', project['name']), '项目名称', 200)
        customer = text(payload.get('customer', project['customer']), '客户', 200)
        department = text(payload.get('department', project['department']), '项目部门', 100, False)
        if department != project['department']:
            require_role(actor, {'admin'})
        removed = set(project['members']) - set(members)
        for employee_id in removed:
            if c.execute("SELECT 1 FROM tasks WHERE project_id=? AND assignee_id=? AND status IN ('pending','submitted') LIMIT 1", (pid, employee_id)).fetchone():
                fail('被移出成员仍有待办或待验收任务，请先退回并转交任务', 'OPEN_TASKS', 409)
        old = {k: project[k] for k in ('name', 'customer', 'ownerId', 'members', 'department')}
        updated = {'name': name, 'customer': customer, 'ownerId': owner, 'members': members, 'department': department}
        c.execute('UPDATE projects SET name=?,customer=?,owner_id=?,members_json=?,department=? WHERE id=?', (name, customer, owner, dump(members), department, pid))
        audit(c, actor['id'], action, pid, {'before': old, 'after': updated})
        return project_for(c, pid)
    if action == 'document.create':
        return create_document(c, actor, payload)
    if action == 'task.create':
        project = check_project(c, actor, text(payload.get('projectId'), '项目编号', 100))
        if project['ownerId'] != actor['id']:
            require_role(actor, {'project_manager', 'manager'})
        assignee = text(payload.get('assigneeId'), '任务负责人', 100)
        if assignee not in project['members'] and assignee != project['ownerId']:
            fail('任务负责人必须是项目成员')
        tid = uid('TASK')
        c.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', (tid, project['id'], text(payload.get('title'), '任务名称', 200), assignee, actor['id'], date(payload.get('dueDate'), '截止日期'), 'pending', '', '[]', now(), None, None, None))
        audit(c, actor['id'], action, tid)
        return task_for(c, tid, actor)
    if action == 'task.complete':
        tid = text(payload.get('id'), '任务编号', 100)
        task = c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone()
        if task is None:
            fail('任务不存在', 'NOT_FOUND', 404)
        check_project(c, actor, task['project_id'])
        if task['assignee_id'] != actor['id']:
            fail('须由任务负责人提交交付', 'FORBIDDEN', 403)
        if task['status'] != 'pending':
            fail('该任务已经交付，不能重复确认', 'STATE_CONFLICT', 409)
        evidence = payload.get('evidence', [])
        if not isinstance(evidence, list) or not evidence or len(evidence) > 50 or len(dump(evidence)) > 30000:
            fail('提交交付须附至少一项真实文件地址或交付凭证编号')
        validated = []
        for receipt in evidence:
            if not isinstance(receipt, dict):
                fail('交付凭证须包含名称和reference地址或编号')
            validated.append({'name': text(receipt.get('name', '交付凭证'), '凭证名称', 200), 'reference': text(receipt.get('reference'), '凭证地址或编号', 1000)})
        result = text(payload.get('result'), '实际交付说明', 8000)
        submitted_at = now()
        c.execute("UPDATE tasks SET status='submitted',result=?,evidence_json=?,submitted_at=?,completed_at=NULL,accepted_by=NULL WHERE id=?", (result, dump(validated), submitted_at, tid))
        c.execute('INSERT INTO task_events VALUES(?,?,?,?,?,?,?)', (uid('TEV'), tid, 'submitted', actor['id'], result, dump(validated), submitted_at))
        audit(c, actor['id'], action, tid)
        return task_for(c, tid, actor)
    if action == 'task.reassign':
        tid = text(payload.get('id'), '任务编号', 100)
        task = c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone()
        if task is None:
            fail('任务不存在', 'NOT_FOUND', 404)
        project = check_project(c, actor, task['project_id'])
        if project['ownerId'] != actor['id']:
            require_role(actor, {'manager'})
        if task['status'] != 'pending':
            fail('仅待办任务可转交；待验收任务请先退回，已验收任务不能改负责人', 'STATE_CONFLICT', 409)
        assignee = text(payload.get('assigneeId'), '新负责人', 100)
        if assignee not in project['members']:
            fail('新任务负责人必须在本项目成员中', 'FORBIDDEN', 403)
        if assignee == task['assignee_id']:
            fail('请选择不同的任务负责人')
        note = text(payload.get('note'), '转交原因', 4000)
        previous = {'assigneeId': task['assignee_id'], 'result': task['result'], 'evidence': json.loads(task['evidence_json']), 'submittedAt': task['submitted_at']}
        c.execute("UPDATE tasks SET assignee_id=?,result='',evidence_json='[]',submitted_at=NULL,completed_at=NULL,accepted_by=NULL WHERE id=?", (assignee, tid))
        detail = {'before': previous, 'after': {'assigneeId': assignee}, 'note': note}
        c.execute('INSERT INTO task_events VALUES(?,?,?,?,?,?,?)', (uid('TEV'), tid, 'reassigned', actor['id'], note, dump([detail]), now()))
        audit(c, actor['id'], action, tid, detail)
        return task_for(c, tid, actor)
    if action in ('task.accept', 'task.return'):
        tid = text(payload.get('id'), '任务编号', 100)
        task = c.execute('SELECT * FROM tasks WHERE id=?', (tid,)).fetchone()
        if task is None:
            fail('任务不存在', 'NOT_FOUND', 404)
        project = check_project(c, actor, task['project_id'])
        if actor['id'] == task['assignee_id']:
            fail('交付者不能验收或退回自己的任务', 'SELF_APPROVAL', 403)
        if project['ownerId'] != actor['id']:
            require_role(actor, {'manager'})
        if task['status'] != 'submitted' or (action == 'task.accept' and not json.loads(task['evidence_json'])):
            fail('须先提交交付说明和凭证，再由负责人验收', 'STATE_CONFLICT', 409)
        note = text(payload.get('note', ''), '验收意见', 4000, action == 'task.return')
        timestamp = now()
        if action == 'task.accept':
            require_active_project(c, task['project_id'])
            c.execute("UPDATE tasks SET status='completed',completed_at=?,accepted_by=? WHERE id=?", (timestamp, actor['id'], tid))
        else:
            c.execute("UPDATE tasks SET status='pending',completed_at=NULL,accepted_by=NULL WHERE id=?", (tid,))
        c.execute('INSERT INTO task_events VALUES(?,?,?,?,?,?,?)', (uid('TEV'), tid, 'accepted' if action == 'task.accept' else 'returned', actor['id'], note, task['evidence_json'], timestamp))
        audit(c, actor['id'], action, tid, {'note': note})
        return task_for(c, tid, actor)
    if action not in ('document.revise', 'document.submit', 'document.approve', 'document.reject', 'document.receive', 'document.ship', 'document.post'):
        fail('不支持的业务操作')
    did = text(payload.get('id'), '单据编号', 100)
    doc = raw_document(c, did, actor)
    if payload.get('version') is not None and integer(payload['version'], '单据版本') != doc['version']:
        fail('单据已更新，请刷新后核对', 'VERSION_CONFLICT', 409)
    if action == 'document.revise':
        return revise_document(c, actor, doc, payload)
    if action == 'document.submit':
        if doc['requester_id'] != actor['id'] and 'admin' not in actor['roles']:
            fail('须由申请人确认并提交方案', 'FORBIDDEN', 403)
        if doc['status'] != 'draft' or not doc['agent_run_id'] or not doc['proposal_json']:
            fail('须先完成真实虚拟员工协作并核对草案', 'AGENT_REQUIRED', 409)
        update_document(c, doc, 'awaiting_approval')
    elif action in ('document.approve', 'document.reject'):
        if doc['status'] != 'awaiting_approval':
            fail('此单据当前不在审批中', 'STATE_CONFLICT', 409)
        required = CHAINS[doc['type']][doc['approval_index']]
        require_role(actor, {required})
        if actor['id'] == doc['requester_id']:
            fail('申请人不能审批自己的单据', 'SELF_APPROVAL', 403)
        if c.execute("SELECT 1 FROM approvals WHERE document_id=? AND actor_id=? AND decision='approved' AND round=?", (did, actor['id'], doc['approval_round'])).fetchone():
            fail('两级审批须由不同员工处理', 'SEPARATION_REQUIRED', 403)
        note = text(payload.get('note', ''), '审批意见', 4000, False)
        approved = action == 'document.approve'
        if not approved and not note:
            fail('退回时请说明需要修改的内容')
        c.execute('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?)', (uid('APP'), did, doc['approval_index'], required, actor['id'], actor['displayName'], 'approved' if approved else 'rejected', note, now(), doc['approval_round']))
        if approved:
            index = doc['approval_index'] + 1
            update_document(c, doc, 'approved' if index == len(CHAINS[doc['type']]) else 'awaiting_approval', approval_index=index)
        else:
            # Revision explicitly archives this round and invalidates its draft.
            update_document(c, doc, 'rejected')
    elif action == 'document.receive':
        process_receipt(c, actor, doc, payload, 'receive')
    elif action == 'document.ship':
        process_receipt(c, actor, doc, payload, 'ship')
    else:
        post_document(c, actor, doc, payload)
    audit(c, actor['id'], action, did, {'fromStatus': doc['status']})
    return document_for(c, did, actor)


def task_for(c, task_id, actor=None):
    row = dict(c.execute('SELECT id,project_id AS projectId,title,assignee_id AS assigneeId,created_by AS createdBy,due_date AS dueDate,status,result,evidence_json,created_at AS createdAt,completed_at AS completedAt,submitted_at AS submittedAt,accepted_by AS acceptedBy FROM tasks WHERE id=?', (task_id,)).fetchone())
    row['evidence'] = json.loads(row.pop('evidence_json'))
    row['history'] = []
    for event in c.execute('SELECT action,actor_id AS actorId,result,evidence_json,created_at AS createdAt FROM task_events WHERE task_id=? ORDER BY rowid', (task_id,)):
        item = dict(event)
        item['evidence'] = json.loads(item.pop('evidence_json'))
        row['history'].append(item)
    row['allowedActions'] = []
    if actor is not None:
        project = check_project(c, actor, row['projectId'])
        manages = project['ownerId'] == actor['id'] or bool(set(actor['roles']).intersection({'manager', 'admin'}))
        if row['status'] == 'pending':
            if row['assigneeId'] == actor['id']:
                row['allowedActions'].append('complete')
            if manages:
                row['allowedActions'].append('reassign')
        elif row['status'] == 'submitted' and row['assigneeId'] != actor['id'] and manages:
            if project['status'] == 'active' and row['evidence']:
                row['allowedActions'].append('accept')
            row['allowedActions'].append('return')
    return row


def record_agent(c, payload):
    doc = raw_document(c, text(payload.get('documentId'), '单据编号', 100))
    if doc['status'] != 'draft':
        fail('审批开始后不能替换方案；被退回后请先修订资料', 'STATE_CONFLICT', 409)
    run_id = text(payload.get('runId'), '真实协作运行编号', 150)
    proposal, evidence = payload.get('proposal'), payload.get('evidence')
    if not isinstance(proposal, (dict, str)) or not proposal or len(dump(proposal)) > 160000:
        fail('协作草案为空或超过上限')
    if not isinstance(evidence, list) or len(evidence) < 2 or len(dump(evidence)) > 200000:
        fail('需要至少两名虚拟员工的真实执行凭证')
    agents = set()
    for receipt in evidence:
        if not isinstance(receipt, dict):
            fail('协作凭证须为对象')
        agents.add(text(receipt.get('agentId'), '执行员工编号', 100))
        if receipt.get('success') is False:
            fail('协作仍有失败步骤，不能提交审批', 'AGENT_INCOMPLETE', 409)
    if len(agents) < 2:
        fail('须由不同虚拟员工完成整理与复核')
    if doc['agent_run_id'] == run_id:
        if doc['proposal_json'] != dump(proposal) or doc['evidence_json'] != dump(evidence):
            fail('同一协作运行不能替换已经登记的结果', 'IDEMPOTENCY_CONFLICT', 409)
        return document_for(c, doc['id'])
    if payload.get('expectedVersion') is not None and payload['expectedVersion'] != doc['version']:
        fail('协作使用的资料版本已过期', 'VERSION_CONFLICT', 409)
    if c.execute('SELECT 1 FROM agent_results WHERE document_id=? AND run_id=?', (doc['id'], run_id)).fetchone():
        fail('不能复用修订前或已替换的协作结果，请重新执行', 'AGENT_STALE', 409)
    c.execute('INSERT INTO agent_results VALUES(?,?,?,?,?,?,?)', (uid('AGR'), doc['id'], doc['approval_round'], run_id, dump(proposal), dump(evidence), now()))
    update_document(c, doc, 'draft', proposal_json=dump(proposal), evidence_json=dump(evidence), agent_run_id=run_id)
    audit(c, 'virtual-employees', 'document.agent_result', doc['id'], {'runId': run_id, 'agentIds': sorted(agents)})
    return document_for(c, doc['id'])


def snapshot(c, actor):
    projects = [project_for(c, r['id']) for r in c.execute('SELECT id FROM projects ORDER BY created_at DESC')]
    projects = [p for p in projects if project_access(actor, p)]
    project_ids = {p['id'] for p in projects}
    documents = [document_for(c, r['id'], actor) for r in c.execute('SELECT * FROM documents ORDER BY created_at DESC') if document_access(c, actor, r)]
    document_ids = {d['id'] for d in documents}
    products = [dict(r) for r in c.execute('SELECT id,sku,name,unit,price_cents AS priceCents,created_at AS createdAt FROM products ORDER BY name,id')]
    inventory = [dict(r) for r in c.execute('SELECT p.id AS productId,p.sku,p.name,p.unit,COALESCE(i.quantity,0) AS quantity FROM products p LEFT JOIN inventory i ON p.id=i.product_id ORDER BY p.sku')]
    movements = [dict(r) for r in c.execute('SELECT id,document_id AS documentId,line_id AS lineId,product_id AS productId,delta,balance,kind,reference,actor_id AS actorId,created_at AS createdAt FROM movements ORDER BY created_at DESC') if r['documentId'] in document_ids]
    tasks = [task_for(c, r['id'], actor) for r in c.execute('SELECT id,project_id FROM tasks ORDER BY created_at DESC') if r['project_id'] in project_ids]
    loans = [dict(r) for r in c.execute('SELECT id,document_id AS documentId,product_id AS productId,employee_id AS employeeId,quantity,returned_quantity AS returnedQuantity FROM loans') if r['documentId'] in document_ids or r['employeeId'] == actor['id']]
    performance = []
    for row in c.execute('SELECT id,document_id AS documentId,project_id AS projectId,period_start AS periodStart,period_end AS periodEnd,facts_json,confirmed_by AS confirmedBy,created_at AS createdAt FROM performance ORDER BY created_at DESC'):
        if row['projectId'] in project_ids:
            item = dict(row)
            item['facts'] = json.loads(item.pop('facts_json'))
            performance.append(item)
    audits = []
    for row in c.execute('SELECT id,actor_id AS actorId,action,entity_id AS entityId,detail_json,created_at AS createdAt FROM audit ORDER BY created_at DESC LIMIT 1000'):
        if 'admin' in actor['roles'] or row['actorId'] == actor['id'] or row['entityId'] in document_ids or row['entityId'] in project_ids:
            item = dict(row)
            item['detail'] = json.loads(item.pop('detail_json'))
            audits.append(item)
    return {'products': products, 'projects': projects, 'documents': documents, 'tasks': tasks, 'inventory': inventory, 'movements': movements, 'loans': loans, 'performance': performance, 'audit': audits, 'warehouse': {'id': 'main', 'name': '公司仓库'}, 'generatedAt': now()}


def backup_database(c, db, message):
    value = message.get('payload', {}).get('destination')
    destination = Path(value) if isinstance(value, str) else Path('')
    backup_root = db.parent.parent / 'backups'
    if (not destination.is_absolute() or destination.parent != backup_root or
            not re.fullmatch(r'[A-Za-z0-9_.-]+\.sqlite', destination.name)):
        fail('备份须位于本公司backups目录', 'FORBIDDEN', 403)
    backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if backup_root.resolve() != db.parent.parent.resolve() / 'backups':
        fail('备份目录不能指向其他位置', 'FORBIDDEN', 403)
    actor = actor_for(message['actor']) if message.get('actor') is not None else None
    if actor is not None:
        require_role(actor, {'admin'})
    try:
        fd = os.open(str(destination), os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        os.close(fd)
    except FileExistsError:
        fail('备份文件已存在，不覆盖已有备份', 'BACKUP_EXISTS', 409)
    target = None
    complete = False
    try:
        target = sqlite3.connect(str(destination))
        deadline = time.monotonic() + 15
        page_size = c.execute('PRAGMA page_size').fetchone()[0]

        def progress(_status, _remaining, pages):
            if time.monotonic() > deadline or pages * page_size > 512 * 1024 * 1024:
                fail('备份超过时间或容量上限，未保留不完整文件', 'LIMIT', 413)

        # sqlite3.backup takes a coherent online snapshot, including committed
        # WAL pages. Copying the live database file would omit those pages.
        c.backup(target, pages=128, progress=progress, sleep=0.01)
        integrity = target.execute('PRAGMA integrity_check').fetchone()[0]
        if integrity != 'ok' or target.execute('PRAGMA foreign_key_check').fetchone() is not None:
            fail('备份完整性检查未通过', 'BACKUP_INVALID', 503)
        target.close()
        target = None
        digest = hashlib.sha256()
        with destination.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
        result = {'path': str(destination), 'fileName': destination.name, 'bytes': destination.stat().st_size, 'sha256': digest.hexdigest(), 'integrity': 'ok', 'createdAt': now()}
        c.execute('BEGIN IMMEDIATE')
        audit(c, actor['id'] if actor else 'system-backup', 'backup.created', destination.name, {'bytes': result['bytes'], 'sha256': result['sha256'], 'integrity': 'ok'})
        c.commit()
        complete = True
        return result
    finally:
        if target is not None:
            target.close()
        if not complete:
            destination.unlink(missing_ok=True)


def main(message):
    db = Path(message.get('databasePath', ''))
    if not db.is_absolute() or db.name != 'office-erp.sqlite' or db.parent.name != 'erp':
        fail('业务台账目录无效')
    db.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    c = sqlite3.connect(str(db), timeout=15, isolation_level=None)
    c.row_factory = sqlite3.Row
    try:
        os.chmod(db, 0o600)
        c.execute('PRAGMA foreign_keys=ON')
        c.execute('PRAGMA busy_timeout=15000')
        c.executescript(SCHEMA)
        # Serialize small schema upgrades as well as business writes. A partial
        # development ledger from the earlier schema remains readable.
        c.execute('BEGIN IMMEDIATE')
        if 'system_movement_id' not in {r['name'] for r in c.execute('PRAGMA table_info(document_lines)')}:
            c.execute("ALTER TABLE document_lines ADD COLUMN system_movement_id TEXT NOT NULL DEFAULT ''")
        if 'approval_round' not in {r['name'] for r in c.execute('PRAGMA table_info(documents)')}:
            c.execute('ALTER TABLE documents ADD COLUMN approval_round INTEGER NOT NULL DEFAULT 1')
        if 'round' not in {r['name'] for r in c.execute('PRAGMA table_info(approvals)')}:
            c.execute('ALTER TABLE approvals ADD COLUMN round INTEGER NOT NULL DEFAULT 1')
        task_columns = {r['name'] for r in c.execute('PRAGMA table_info(tasks)')}
        if 'submitted_at' not in task_columns:
            c.execute('ALTER TABLE tasks ADD COLUMN submitted_at TEXT')
        if 'accepted_by' not in task_columns:
            c.execute('ALTER TABLE tasks ADD COLUMN accepted_by TEXT')
        # Earlier self-reported completions did not include independent human
        # acceptance and therefore cannot count as confirmed contribution.
        c.execute("UPDATE tasks SET status='submitted',submitted_at=COALESCE(submitted_at,completed_at),completed_at=NULL WHERE status='completed' AND accepted_by IS NULL")
        # Preserve a pre-upgrade current result before any later revision.
        c.execute("INSERT OR IGNORE INTO agent_results SELECT 'LEGACY-' || id,id,approval_round,agent_run_id,proposal_json,evidence_json,updated_at FROM documents WHERE agent_run_id IS NOT NULL AND proposal_json IS NOT NULL")
        c.execute('PRAGMA user_version=4')
        c.commit()
        if message.get('operation') == 'backup':
            return backup_database(c, db, message)
        c.execute('BEGIN IMMEDIATE' if message.get('operation') != 'snapshot' else 'BEGIN')
        if message.get('operation') == 'agent_result':
            result = record_agent(c, message.get('payload', {}))
        else:
            actor = actor_for(message.get('actor'))
            if message.get('operation') == 'snapshot':
                result = snapshot(c, actor)
            elif message.get('operation') == 'command':
                action = text(message.get('action'), '业务操作', 100)
                payload = message.get('payload', {})
                key = text(message.get('idempotencyKey'), '请求编号', 150)
                request_hash = hashlib.sha256(dump({'action': action, 'payload': payload}).encode()).hexdigest()
                cached = c.execute('SELECT * FROM idempotency WHERE actor_id=? AND key=?', (actor['id'], key)).fetchone()
                if cached:
                    if cached['request_hash'] != request_hash:
                        fail('同一请求编号不能提交不同内容', 'IDEMPOTENCY_CONFLICT', 409)
                    result = json.loads(cached['response_json'])
                    if result.get('workflowId'):
                        raw_document(c, result['id'], actor)
                else:
                    result = command(c, actor, action, payload)
                    c.execute('INSERT INTO idempotency VALUES(?,?,?,?)', (actor['id'], key, request_hash, dump(result)))
            else:
                fail('不支持的台账操作')
        c.commit()
        return result
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            fail('请求超过上限', 'LIMIT', 413)
        print(dump({'ok': True, 'result': main(json.loads(raw))}))
    except DomainError as error:
        print(dump({'ok': False, 'error': str(error), 'code': error.code, 'status': error.status}))
    except sqlite3.IntegrityError:
        print(dump({'ok': False, 'error': '资料重复或违反业务约束，事务未提交', 'code': 'CONSTRAINT', 'status': 409}))
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        print(dump({'ok': False, 'error': '业务资料格式无效，事务未提交', 'code': 'VALIDATION', 'status': 400}))
    except Exception:
        print(dump({'ok': False, 'error': '业务台账暂不可用，事务未提交', 'code': 'UNAVAILABLE', 'status': 503}))
