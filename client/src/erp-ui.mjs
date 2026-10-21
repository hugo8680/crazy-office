export const WORKFLOWS = [
  {id:'project_setup',name:'项目立项',area:'项目',note:'确定目标、负责人和交付日期',needsProject:true},
  {id:'project_delivery',name:'交付验收',area:'项目',note:'核对交付内容与验收记录',needsProject:true},
  {id:'purchase',name:'采购补货',area:'进销存',note:'核对缺口、报价与采购申请',lines:true,priced:true},
  {id:'sales',name:'销售交付',area:'进销存',note:'确认客户订单、库存与发货',lines:true,priced:true},
  {id:'stocktake',name:'库存盘点',area:'进销存',note:'登记实盘数量并核对差异',lines:true,counted:true},
  {id:'resource',name:'办公领用与归还',area:'办公',note:'登记员工领用与归还记录',lines:true},
  {id:'weekly_report',name:'项目周报与贡献',area:'绩效',note:'汇总项目事实、完成记录与待办',needsProject:true},
  {id:'onboarding',name:'员工岗位与资源',area:'人员',note:'准备岗位职责、设备与账号待办'}
];
export const LABELS={draft:'草稿',agent_running:'处理中',running:'处理中',agent_failed:'处理失败',agent_ready:'待提交',awaiting_agent:'待处理',awaiting_approval:'等待审批',pending_approval:'等待审批',approved:'审批通过',rejected:'已退回',returned:'已退回',posted:'已办理',completed:'已完成',failed:'执行失败',cancelled:'已取消',active:'使用中',inactive:'已停用',pending:'待处理',done:'已完成',queued:'等待处理',partially_received:'部分收货',partially_shipped:'部分发货',invited:'待入驻',disabled:'已停用',submitted:'待验收',accepted:'已验收'};
export const ACTION_LABELS={revise:'修改业务单',submit:'提交审批',approve:'同意',return:'退回修改',reject:'退回修改',receive:'确认收货',ship:'确认发货',post:'确认办理',complete:'确认完成',run_agent:'提交处理',run_agents:'提交处理',retry_agent:'重新处理',retry:'重新处理',agent:'提交处理',cancel:'撤销'};
export const ROLE_LABELS={admin:'系统管理员',manager:'部门负责人',project_manager:'项目负责人',finance:'财务',warehouse:'仓管',hr:'人事',employee:'员工',procurement:'采购'};
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const list=value=>Array.isArray(value)?value:[];
export const statusLabel=value=>LABELS[value]||value||'—';
export const workflowName=value=>WORKFLOWS.find(item=>item.id===value)?.name||value||'业务单';
export const dateText=value=>{if(!value)return'—';const d=new Date(value);return Number.isNaN(d.valueOf())?'—':d.toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'});};
export const money=value=>{if(value==null||value==='')return '—';try{const n=typeof value==='bigint'?value:BigInt(Number.isSafeInteger(Number(value))?Number(value):'invalid'),negative=n<0n,absolute=negative?-n:n;return (negative?'-':'')+'¥'+(absolute/100n).toLocaleString('zh-CN')+'.'+String(absolute%100n).padStart(2,'0');}catch{return '—';}};
export function cents(value){const text=String(value??'').trim();if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw new Error('金额需为非负数，最多两位小数。');const [a,b='']=text.split('.'),result=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(result))throw new Error('金额超出可用范围。');return result;}
export function safeFileUrl(value){return typeof value==='string'&&/^\/api\/(?!.*(?:[\\\u0000-\u0020]|\.\.))[^?#]+(?:\?[^#\u0000-\u0020]*)?$/.test(value)?value:'';}
export function normalizeSnapshot(value={}){const s=value.snapshot||value;return {...s,products:list(s.products),projects:list(s.projects),documents:list(s.documents||s.workitems),tasks:list(s.tasks),inventory:list(s.inventory),movements:list(s.movements),loans:list(s.loans),performance:list(s.performance),audit:list(s.audit),users:list(s.users),invitations:list(s.invitations)};}
export function allowedActions(document){return list(document?.allowedActions).map(item=>typeof item==='string'?{id:item,label:ACTION_LABELS[item]||item}:({...item,id:item.id||item.action,label:ACTION_LABELS[item.id||item.action]||item.label||item.id||item.action})).filter(item=>item.id&&item.allowed!==false);}
export function pendingTasks(snapshot,userId){const own=(snapshot.tasks||[]).filter(item=>!['completed','done','cancelled'].includes(item.status)&&(!item.assigneeId||item.assigneeId===userId||list(item.allowedActions).some(action=>['accept','return','reject'].includes(typeof action==='string'?action:action.id||action.action))));const approvals=(snapshot.documents||[]).filter(item=>allowedActions(item).some(action=>action.id==='approve'));return {tasks:own,approvals};}
function text(value,label,required=true){const v=String(value??'').trim();if(required&&!v)throw new Error(`请填写${label}。`);return v;}
function quantity(value,label,zero=false){const n=Number(value);if(String(value??'').trim()===''||!Number.isSafeInteger(n)||n<0||(!zero&&n===0)||Math.abs(n)>1e9)throw new Error(`${label}需为${zero?'非负':'大于 0 的'}有效整数。`);return n;}
function validDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;}
export function buildDocumentPayload(type,values,rows=[]){
  const w=WORKFLOWS.find(item=>item.id===type);if(!w)throw new Error('请选择有效业务。');
  const payload={type,title:text(values.title,'业务名称'),input:{}};
  if(values.projectId)payload.projectId=String(values.projectId);if(w.needsProject&&!payload.projectId)throw new Error('请选择项目。');
  const input=payload.input;
  if(['purchase','sales'].includes(type)){input.partner=text(values.partner,type==='purchase'?'供应商':'客户');if(values.expectedDate)input.expectedDate=String(values.expectedDate);}
  if(type==='purchase'){for(const [key,label,max] of [['quotationReference','供应商报价凭证',1000],['quotationNotes','报价依据与条件',4000]]){const value=text(values[key],label,false);if(value.length>max)throw new Error(`${label}最多 ${max} 个字符。`);if(value)input[key]=value;}}if(type==='stocktake')input.note=text(values.note,'盘点原因及依据');if(type==='project_setup'){input.objective=text(values.objective,'项目目标');if(values.expectedDate)input.expectedDate=String(values.expectedDate);}
  if(type==='project_delivery'){input.acceptanceCriteria=text(values.acceptanceCriteria,'验收标准');input.deliveryNote=text(values.deliveryNote,'交付内容');}
  if(type==='resource'){input.operation=values.operation==='return'?'return':'issue';input.employeeId=text(values.employeeId,'领用员工');input.purpose=text(values.purpose,'物品用途');if(values.sourceOnboardingDocumentId)input.sourceOnboardingDocumentId=String(values.sourceOnboardingDocumentId);if(input.operation==='return')input.originalDocumentId=text(values.originalDocumentId,'原领用单');}
  if(type==='onboarding'){input.employeeId=text(values.employeeId,'员工');input.position=text(values.position,'岗位');input.resourceRequirements=text(values.resourceRequirements,'资源需求');}
  if(type==='weekly_report'){input.periodStart=text(values.periodStart,'开始日期');input.periodEnd=text(values.periodEnd,'结束日期');if(!validDate(input.periodStart)||!validDate(input.periodEnd)||input.periodStart>input.periodEnd)throw new Error('报表日期范围无效。');if(values.summary)input.summary=String(values.summary).trim();}
  if(w.lines){if(!rows.length)throw new Error('请至少添加一个产品。');const seen=new Set();payload.lines=rows.map(row=>{const productId=text(row.productId,'产品');if(seen.has(productId))throw new Error('同一产品请合并为一行。');seen.add(productId);const line={productId};if(w.counted)line.countedQuantity=quantity(row.countedQuantity,'实盘数量',true);else line.quantity=quantity(row.quantity,'数量');if(w.priced)line.unitPriceCents=cents(row.unitPrice);return line;});}
  return payload;
}
export function fulfillmentLines(document,rows,action){const key=action==='receive'?'receivedQuantity':'shippedQuantity';const result=[];for(const row of rows){if(row.quantity===''||row.quantity==null||Number(row.quantity)===0)continue;const line=list(document.lines).find(item=>item.id===row.lineId||item.lineId===row.lineId);if(!line)throw new Error('产品行已变更，请重新打开单据。');const n=quantity(row.quantity,'本次数量'),remaining=Number(line.quantity)-Number(line.completedQuantity??line[key]??0);if(n>remaining)throw new Error('本次数量超过剩余待办数量。');result.push({lineId:row.lineId,quantity:n});}if(!result.length)throw new Error('请填写本次实际办理数量。');return result;}
export function assertAllowedAction(document,id){if(!allowedActions(document).some(item=>item.id===id))throw new Error('当前状态或账号无权执行此操作，请刷新单据。');return id;}
export function renderEmpty(message,action=''){return `<div class="erp-empty"><span aria-hidden="true"><svg viewBox="0 0 32 32"><path d="m7 11 9-5 9 5v12l-9 5-9-5Z"/><path d="m7 11 9 5 9-5M16 16v12M11 9l10 6"/></svg></span><p>${escapeHtml(message)}</p>${action}</div>`;}
export function renderStatus(value){return `<span class="erp-status erp-status-${escapeHtml(value||'unknown')}">${escapeHtml(statusLabel(value))}</span>`;}
export function renderActions(document){return allowedActions(document).map(item=>`<button type="button" class="erp-button ${['approve','receive','ship','post','submit','run_agent','run_agents','retry_agent'].includes(item.id)?'erp-primary':''}" data-erp-action="document-action" data-id="${escapeHtml(document.id)}" data-operation="${escapeHtml(item.id)}" ${item.disabled?'disabled':''}>${escapeHtml(item.label)}</button>`).join('');}
export function renderFiles(files){return list(files).map(file=>{const url=safeFileUrl(file.url||file.downloadUrl);return `<li><span><strong>${escapeHtml(file.name||file.title||'交付文件')}</strong><small>${escapeHtml(file.description||file.kind||'')}</small></span>${url?`<a class="erp-button" href="${escapeHtml(url)}" download>下载</a>`:'<span class="erp-muted">暂无下载地址</span>'}</li>`;}).join('');}
export function csvDocument(headers,rows){const cell=value=>{let text=String(value??'');if(typeof value!=='number'&&/^\s*[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};return '\ufeff'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';}
export function safeSourceUrl(value){if(typeof value!=='string'||/[\u0000-\u0020\\]/.test(value))return '';try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export function renderQuoteEvidence(evidence){
  const quotes=list(evidence?.quotes),validPrice=quote=>quote.status==='priced'&&(typeof quote.price==='number'||typeof quote.price==='string'&&/^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(quote.price.trim()))&&Number.isFinite(Number(quote.price))&&Number(quote.price)>=0;
  const priced=quotes.filter(validPrice),pending=quotes.filter(quote=>!validPrice(quote));
  const source=quote=>{const url=safeSourceUrl(quote.sourceUrl);return `<strong>${escapeHtml(quote.title||'来源页面')}</strong>${url?`<small><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">打开原始网页 ↗</a></small>`:'<small>来源链接不可用</small>'}`;};
  const notes=quote=>{const parts=[quote.reason||quote.limitation],selected=list(quote.selectedConfiguration),configuration=list(quote.configurationEvidence);if(selected.length)parts.push('选定配置：'+selected.join('；'));else if(configuration.length)parts.push('页面配置：'+configuration.join('；'));for(const [key,label]of [['tax','税费'],['shipping','运费'],['warranty','保修']])if(quote[key])parts.push(`${label}：${quote[key]}`);return escapeHtml(parts.filter(Boolean).join('；')||'配置、税费、运输及保修待确认');};
  const table=(items,isPriced)=>`<div class="erp-table-wrap"><table class="erp-table"><thead><tr>${['来源',isPriced?'公开标价':'确认事项','获取日期','配置与条款'].map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${items.map(quote=>{const value=isPriced?Number(quote.price).toLocaleString('zh-CN',{maximumFractionDigits:2})+' '+(quote.currency||'币种未确认'):quote.status==='multiple_price_candidates'?'同页多价，待核对':['pending_inquiry','unpriced'].includes(quote.status)?'待询价':'未取得可用标价';return `<tr><td>${source(quote)}</td><td>${escapeHtml(value)}</td><td>${escapeHtml(dateText(quote.fetchedAt))}</td><td>${notes(quote)}</td></tr>`;}).join('')}</tbody></table></div>`;
  return (priced.length?`<h3 class="erp-result-subtitle">公开标价</h3>${table(priced,true)}`:'<p class="erp-quote-empty">尚未取得可用报价</p>')+(pending.length?`<details class="erp-history erp-quote-pending"><summary>待确认来源（${pending.length}）</summary>${table(pending,false)}</details>`:'');
}

// All summaries below use authenticated ledger rows. No forecast or estimated revenue is inferred.
export function reportFacts(value={}){
  const s=normalizeSnapshot(value),integer=v=>Number.isSafeInteger(Number(v))?Number(v):0;
  const confirmed=new Set(['approved','completed','posted','partially_received','partially_shipped']);
  const documents=s.documents.filter(d=>confirmed.has(d.status));
  const orderTotal=type=>documents.filter(d=>d.type===type).reduce((total,d)=>total+list(d.lines).reduce((n,l)=>n+BigInt(integer(l.quantity))*BigInt(integer(l.unitPriceCents)),0n),0n);
  const movementRows=s.movements.map(m=>({...m,delta:integer(m.delta??m.quantity)}));
  const projects=s.projects.map(p=>{const tasks=s.tasks.filter(t=>t.projectId===p.id),done=tasks.filter(t=>['completed','done'].includes(t.status)),submitted=tasks.filter(t=>t.status==='submitted');return {...p,total:tasks.length,completed:done.length,submitted:submitted.length,pending:tasks.length-done.length-submitted.length,completion:tasks.length?Math.round(done.length/tasks.length*100):null};});
  const performance=s.performance.flatMap(record=>list(record.facts?.employees).map(employee=>({...employee,projectId:record.projectId,periodStart:record.periodStart,periodEnd:record.periodEnd,confirmedBy:record.confirmedBy,documentId:record.documentId,pendingAcceptanceTasks:list(record.facts?.taskFacts).filter(task=>task.stateAtPeriodEnd==='submitted'&&task.assigneeIdAtPeriodEnd===employee.employeeId).length})));
  const products=s.inventory.map(item=>{const p=s.products.find(p=>p.id===item.productId)||{},moves=movementRows.filter(m=>m.productId===item.productId);return {...item,name:item.name||item.productName||p.name||item.productId,unit:item.unit||p.unit,quantity:integer(item.quantity??item.onHand),inQuantity:moves.filter(m=>m.delta>0).reduce((n,m)=>n+m.delta,0),outQuantity:moves.filter(m=>m.delta<0).reduce((n,m)=>n-m.delta,0)};});
  return {projects,performance,products,movements:movementRows,purchaseOrderCents:orderTotal('purchase'),salesOrderCents:orderTotal('sales'),confirmedOrders:documents.filter(d=>['purchase','sales'].includes(d.type)),completedDocuments:s.documents.filter(d=>['posted','completed'].includes(d.status)),outstandingLoanCount:new Set(s.loans.filter(l=>integer(l.quantity??l.issuedQuantity)>integer(l.returnedQuantity)).map(l=>l.documentId||l.id||l.employeeId+':'+l.productId)).size,outstandingLoans:s.loans.reduce((n,l)=>n+Math.max(0,integer(l.quantity??l.issuedQuantity)-integer(l.returnedQuantity)),0)};
}
export function renderBusinessResult(document={},context={}){
  const proposal=document.proposal||{},plan=proposal.plan||{},review=proposal.review||{},calculation=proposal.calculation||context.calculation||{},quotes=document.quoteEvidence||context.quoteEvidence;
  const block=(label,items)=>list(items).length?`<section class="erp-result-block"><h3>${escapeHtml(label)}</h3><ul>${items.map(item=>`<li>${escapeHtml(typeof item==='string'?item:item?.summary||item?.title||item?.note||JSON.stringify(item))}</li>`).join('')}</ul></section>`:'';
  const missing=[...new Set([...list(plan.missing),...list(review.missing)].map(v=>typeof v==='string'?v:JSON.stringify(v)))];
  const summary=typeof plan==='string'?plan:plan.summary;
  const lines=list(calculation.lines);
  let html=summary?`<p class="erp-result-summary">${escapeHtml(summary)}</p>`:'';
  if(lines.length)html+=`<div class="erp-table-wrap"><table class="erp-table"><thead><tr>${['产品',document.type==='stocktake'?'实盘数量':'数量','核对时库存',...(document.type==='stocktake'?['账面数量','差异']:[]),'单价','金额'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${lines.map(l=>`<tr><td>${escapeHtml(l.product||l.productName||l.productId)}</td><td>${escapeHtml(l.quantity??l.countedQuantity??'—')}</td><td>${escapeHtml(l.currentStock??'—')}</td>${document.type==='stocktake'?`<td>${escapeHtml(l.bookQuantity??'—')}</td><td>${escapeHtml(l.difference??'—')}</td>`:''}<td>${money(l.unitPriceCents)}</td><td>${money(l.lineTotalCents)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="${document.type==='stocktake'?6:4}">${document.type==='sales'?'订单金额':document.type==='purchase'?'申请金额':'参考金额'}</th><td>${money(calculation.totalCents)}</td></tr></tfoot></table></div>`;
  html+=block('办理事项',plan.steps)+block('待补充',missing);
  const checks=[...new Set([...list(plan.checks),...list(review.checks)].map(v=>typeof v==='string'?v:JSON.stringify(v)))];
  html+=block('核对结论',checks);
  if(review.summary&&review.summary!==summary)html+=`<p class="erp-review-summary">${escapeHtml(review.summary)}</p>`;
  if(quotes&&Array.isArray(quotes.quotes))html+=renderQuoteEvidence(quotes);
  return html;
}

export function weeklyDocumentCounts(facts={}){const documents=list(facts.businessDocuments);return {documentCount:documents.length,typeCount:new Set(documents.map(d=>d.type).filter(Boolean)).size};}
