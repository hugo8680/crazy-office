package erp

func (q *ledger) snapshot(a Actor) map[string]any {
	projects := []map[string]any{}
	projectIDs := map[string]bool{}
	for _, r := range q.rows("SELECT id FROM projects ORDER BY created_at DESC") {
		p := q.project(str(r["id"]))
		if projectAccess(a, p) {
			projects = append(projects, p)
			projectIDs[str(p["id"])] = true
		}
	}
	documents := []map[string]any{}
	documentIDs := map[string]bool{}
	for _, r := range q.rows("SELECT * FROM documents ORDER BY created_at DESC") {
		if q.documentAccess(a, r) {
			d := q.document(str(r["id"]), &a)
			documents = append(documents, d)
			documentIDs[str(d["id"])] = true
		}
	}
	products := q.rows("SELECT id,sku,name,unit,price_cents AS priceCents,created_at AS createdAt FROM products ORDER BY name,id")
	inventory := q.rows("SELECT p.id AS productId,p.sku,p.name,p.unit,COALESCE(i.quantity,0) AS quantity FROM products p LEFT JOIN inventory i ON p.id=i.product_id ORDER BY p.sku")
	movements := []map[string]any{}
	for _, r := range q.rows("SELECT id,document_id AS documentId,line_id AS lineId,product_id AS productId,delta,balance,kind,reference,actor_id AS actorId,created_at AS createdAt FROM movements ORDER BY created_at DESC") {
		if documentIDs[str(r["documentId"])] {
			movements = append(movements, r)
		}
	}
	tasks := []map[string]any{}
	for _, r := range q.rows("SELECT id,project_id FROM tasks ORDER BY created_at DESC") {
		if projectIDs[str(r["project_id"])] {
			tasks = append(tasks, q.taskFor(str(r["id"]), &a))
		}
	}
	loans := []map[string]any{}
	for _, r := range q.rows("SELECT id,document_id AS documentId,product_id AS productId,employee_id AS employeeId,quantity,returned_quantity AS returnedQuantity FROM loans") {
		if documentIDs[str(r["documentId"])] || r["employeeId"] == a.ID {
			loans = append(loans, r)
		}
	}
	performance := []map[string]any{}
	for _, r := range q.rows("SELECT id,document_id AS documentId,project_id AS projectId,period_start AS periodStart,period_end AS periodEnd,facts_json,confirmed_by AS confirmedBy,created_at AS createdAt FROM performance ORDER BY created_at DESC") {
		if projectIDs[str(r["projectId"])] {
			r["facts"] = parse(r["facts_json"])
			delete(r, "facts_json")
			performance = append(performance, r)
		}
	}
	audit := []map[string]any{}
	for _, r := range q.rows("SELECT id,actor_id AS actorId,action,entity_id AS entityId,detail_json,created_at AS createdAt FROM audit ORDER BY created_at DESC LIMIT 1000") {
		if has(a.Roles, "admin") || r["actorId"] == a.ID || documentIDs[str(r["entityId"])] || projectIDs[str(r["entityId"])] {
			r["detail"] = parse(r["detail_json"])
			delete(r, "detail_json")
			audit = append(audit, r)
		}
	}
	return map[string]any{"products": products, "projects": projects, "documents": documents, "tasks": tasks, "inventory": inventory, "movements": movements, "loans": loans, "performance": performance, "audit": audit, "warehouse": map[string]any{"id": "main", "name": "公司仓库"}, "generatedAt": now()}
}
