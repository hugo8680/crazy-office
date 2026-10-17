import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createInvestmentFunctions,INVESTMENT_TOOL_DEFINITIONS} from '../server/investment.mjs';
import {createToolbox,isDirectlyConnectedAddress,validatePublicUrl} from '../server/tools.mjs';
function fixture(input={},options={}){
 const docs=new Map(),outputs={},calls=[],validated=[],approvals=[];
 const actual={projectName:'验收项目',projectBrief:'项目方称已有20家付费客户，声称年收入100.10元。',currency:'CNY',...input};
 const fetch=options.fetch||(async url=>{calls.push(url);if(/bing\.com|duckduckgo\.com/.test(new URL(url).hostname))throw new Error('检索站点受限');return {url,status:200,contentType:'text/html',fetchedAt:'2026-10-17T10:00:00Z',text:'<title>验收项目公开自述</title><p>验收项目称已有20家付费客户，声称年收入100.10元。</p>'};});
 const functions=createInvestmentFunctions({input:actual,outputs,put:async(name,body)=>docs.set(name,body),publicFetch:async url=>{if(options.fetch)calls.push(url);return fetch(url);},validatePublicUrl:async url=>{validated.push(url);const u=new URL(url);if(u.hostname==='127.0.0.1'||u.hostname==='localhost'||u.protocol==='file:')throw new Error('拒绝私网URL');return u;},approval:async p=>{approvals.push(p);return {approved:!!options.approved,note:'明确的单元验收选择'};}});
 const execute=async(name,args={})=>{const r=await functions[name](args);outputs[name]=r.evidence;return r;};
 const prepare=()=>execute('prepare_investment',{claims:[{id:'C1',claim:'已有20家付费客户',sourceQuote:'已有20家付费客户',area:'商业'}]});
 return {execute,prepare,docs,outputs,calls,validated,approvals};
}

test('investment tools parse and are integrated with real server-side role permissions',async()=>{
 assert.equal(INVESTMENT_TOOL_DEFINITIONS.length,6);const dir=await fs.mkdtemp(path.join(os.tmpdir(),'investment-permissions-'));
 try{const b=await createToolbox({runDir:dir,input:{projectName:'验收项目',projectBrief:'项目方称已有20家付费客户。'}});assert(b.definitions.some(d=>d.name==='prepare_investment'));await assert.rejects(()=>b.execute('prepare_investment',{},'finance'),/没有.*权限/);const r=await b.execute('prepare_investment',{claims:[{id:'C1',claim:'20客户',sourceQuote:'已有20家付费客户'}]},'invest_research');assert.equal(r.evidence.claims.length,1);assert(b.artifacts().some(a=>a.name==='dossier.json'));}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('investment finances use exact cents, permit losses, preserve missing fields and calculate terms',async()=>{
 const f=fixture({example:true,plannedInvestment:'0.10',preMoneyValuation:'0.20',financials:{records:[{period:'2024',revenue:'100.10',gross_profit:'50.05',net_profit:'-10.01',cash:'',monthly_burn:0,debt:''},{period:'2025',revenue:'150.15',gross_profit:'75.07',net_profit:'-20.02',cash:'40.04',monthly_burn:'5.00'}]}});
 const a=(await f.execute('analyze_investment_financials')).evidence;assert.equal(a.isExample,true);assert.equal(a.records[0].cash,null);assert.equal(a.records[0].cashRunwayMonths,null);assert.equal(a.records[1].amountsCents.revenue,'15015');assert.equal(a.records[1].amountsFixed.net_profit,'-20.02');assert.equal(a.records[1].cashRunwayMonths,8.01);assert.equal(a.revenueGrowthPct,50);assert.equal(a.terms.amountsCents.postMoneyValuation,'30');assert.equal(a.terms.impliedPostMoneyValuation,0.3);assert.equal(a.terms.impliedOwnershipPct,33.33);assert(a.missing.includes('debt'));
 for(const financials of [[{period:'2025',revenue:'1.001'}],[{period:'2025'}],[{period:'x',revenue:1},{period:'x',revenue:2}],'period,revenue,revenue\n2025,1,2'])await assert.rejects(()=>fixture({financials}).execute('analyze_investment_financials'));
 await assert.rejects(()=>fixture({plannedInvestment:'90071992547409.91',preMoneyValuation:'0.01'}).execute('analyze_investment_financials'),/之和超出/);
});

test('investment missing financials remains an explicit gap and cannot authorize investment',async()=>{
 const f=fixture({isExample:true,urls:'https://issuer.example/project'});await f.prepare();const r=await f.execute('research_investment');assert.equal(r.evidence.searchesWithUsableLinks,0);assert.equal(r.evidence.searchAttempts.length,2);assert.equal(r.evidence.retrievedPageCount,1);const finances=(await f.execute('analyze_investment_financials')).evidence;assert.equal(finances.recordCount,0);assert.equal(finances.revenueGrowthPct,null);await f.execute('review_investment',{findings:[{claimId:'C1',verdict:'issuer_claim',reason:'只有项目方自述',citations:[{sourceId:'U1',quote:'已有20家付费客户'}]}]});
 await assert.rejects(()=>f.execute('build_investment_memo',{recommendation:'invest_now',rationale:'立即投资'.repeat(30)}),/不允许批准投资/);const memo=(await f.execute('build_investment_memo',{recommendation:'continue_diligence',rationale:'本次资料不足，公开网页仅为来源说法，缺少历史财务、现金和独立验证，不能确认项目经营质量。建议先补充审计、银行、合同和客户核验材料，再决定后续核查方向，不批准投资、不保证收益。'.repeat(2)})).evidence;assert.equal(memo.recommendation,'request_information');assert.equal(memo.isExample,true);assert.equal(memo.investmentAuthorized,false);assert(memo.criticalGaps.some(g=>g.includes('历史财务')));const decision=(await f.execute('request_investment_review',{approved:true})).evidence;assert.equal(f.approvals.length,1);assert.equal(decision.decision,'pause');assert.equal(decision.investmentAuthorized,false);assert.equal(decision.paymentExecuted,false);
});

test('investment research validates every explicit URL, rejects overflow and records skipped search pages',async()=>{
 const nine=Array.from({length:9},(_,i)=>'https://issuer.example/'+i);for(const urls of [nine,'http://127.0.0.1/private','file:///etc/passwd']){const f=fixture({urls});await f.prepare();await assert.rejects(()=>f.execute('research_investment'));assert.equal(f.calls.length,0);}
 const html=Array.from({length:10},(_,i)=>'<li class="b_algo"><a href="https://issuer.example/discovered-'+i+'">source</a></li>').join('');const f=fixture({urls:['https://issuer.example/explicit-a','https://issuer.example/explicit-b']},{fetch:async url=>({url,status:200,fetchedAt:'2026-10-17T10:00:00Z',contentType:'text/html',text:url.includes('bing.com')?html:'<title>项目来源</title><p>验收项目公开介绍。</p>'})});await f.prepare();const r=(await f.execute('research_investment')).evidence;assert.equal(r.attemptedPageCount,8);assert.equal(r.skippedCandidateUrls.length,4);assert.equal(r.coverageCompleteForProvidedUrls,true);assert.equal(r.sources[1].requestedUrl,'https://issuer.example/explicit-a');assert.equal(r.sources[2].requestedUrl,'https://issuer.example/explicit-b');assert(f.validated.includes('https://issuer.example/explicit-b'));
});

test('investment citations reject unavailable bodies/fabrications and never prove independence from two hosts',async()=>{
 const f=fixture({urls:['https://issuer.example/a','https://other-issuer.example/b','https://blocked.example/c']},{fetch:async url=>{if(/bing\.com|duckduckgo\.com/.test(new URL(url).hostname))throw new Error('blocked search');return {url,status:url.includes('blocked.example')?403:200,fetchedAt:'2026-10-17T10:00:00Z',contentType:'text/html',text:'<title>页面</title><p>验收项目已有20家付费客户。</p>'};}});await f.prepare();await f.execute('research_investment');await f.execute('analyze_investment_financials');for(const citation of [{sourceId:'W3',quote:'验收项目已有20家付费客户。'},{sourceId:'W1',quote:'保证投资收益100%'},{sourceId:'W999',quote:'已有20家'}])await assert.rejects(()=>f.execute('review_investment',{findings:[{claimId:'C1',verdict:'source_supported',citations:[citation]}]}),/引用仅允许/);
 const review=(await f.execute('review_investment',{findings:[{claimId:'C1',verdict:'corroborated',reason:'两域都这样自述，但发布方所有权未查明',citations:[{sourceId:'W1',quote:'验收项目已有20家付费客户。'},{sourceId:'W2',quote:'验收项目已有20家付费客户。'}]}]})).evidence;assert.equal(review.findings[0].verdict,'source_supported');assert.equal(review.findings[0].independentlyVerified,false);assert.equal(review.publisherIndependenceVerified,false);assert(review.findings[0].corroborationStatus.includes('独立性尚未核验'));
});

test('CSV formula protection prefixes without deleting the original quoted value',async()=>{
 const f=fixture({projectBrief:'=2+2是项目方标签。',urls:'https://issuer.example/project'});await f.execute('prepare_investment',{claims:[{id:'C1',claim:'=2+2',sourceQuote:'=2+2'}]});await f.execute('research_investment');await f.execute('analyze_investment_financials');await f.execute('review_investment',{findings:[{claimId:'C1',verdict:'issuer_claim',reason:'@未核实',citations:[{sourceId:'U1',quote:'=2+2'}]}]});const body=f.docs.get('investment/evidence-ledger.csv');assert(body.includes('"\'=2+2"'));assert(body.includes('"\'@未核实"'));
});

test('positive human review only authorizes next diligence, never investment or payment',async()=>{
 const f=fixture({urls:'https://issuer.example/project'},{approved:true});await assert.rejects(()=>f.execute('request_investment_review'),/尚无/);await f.prepare();await f.execute('research_investment');await f.execute('analyze_investment_financials');await f.execute('review_investment',{findings:[{claimId:'C1',verdict:'unverified',reason:'无独立事实证据',citations:[]}]});await f.execute('build_investment_memo',{recommendation:'pause',rationale:'现有证据不足以确认项目经营和财务真实性，缺少独立审计、银行及客户资料，公开页面只是来源自述，后续必须进一步调查与验证。本简报只支持尽调方向，不构成投资批准、支付授权或者收益保证。'.repeat(2)});const answer=(await f.execute('request_investment_review')).evidence;assert.equal(answer.decision,'continue_diligence');assert.equal(answer.investmentAuthorized,false);assert.equal(answer.paymentExecuted,false);assert.equal(f.approvals[0].kind,'investment');
});

test('project financial upload is a traceable U2 source, not falsely rejected as a fabricated quote',async()=>{
 const row='{"period":"2025","revenue":100.10,"cash":50.01}';const f=fixture({financials:{name:'example.json',text:'['+row+']'}});const prepared=(await f.execute('prepare_investment',{claims:[{id:'C1',claim:'项目方财务披露',sourceQuote:row,area:'财务'}]})).evidence;assert.equal(prepared.claims[0].sourceId,'U2');await f.execute('research_investment');assert(f.outputs.research_investment.sources.some(s=>s.id==='U2'&&s.status==='provided'));const review=(await f.execute('review_investment',{findings:[{claimId:'C1',verdict:'issuer_claim',citations:[{sourceId:'U2',quote:row}],reason:'项目方数字未审计'}]})).evidence;assert.equal(review.findings[0].verdict,'issuer_claim');assert.equal(review.findings[0].independentlyVerified,false);
});

test('unrelated citation cannot borrow another page subject match to support the project claim',async()=>{
 const f=fixture({urls:['https://issuer.example/target','https://other.example/unrelated'],financials:[{period:'2025',revenue:100,gross_profit:50,net_profit:10,cash:20,monthly_burn:2,debt:0}]},{fetch:async url=>{if(/bing\.com|duckduckgo\.com/.test(new URL(url).hostname))throw new Error('blocked search');return {url,status:200,fetchedAt:'2026-10-17T10:00:00Z',contentType:'text/html',text:url.includes('/target')?'<title>验收项目</title><p>验收项目背景。</p>':'<title>别家公司</title><p>别家公司已有20家付费客户。</p>'};}});await f.prepare();await f.execute('research_investment');await f.execute('analyze_investment_financials');const r=(await f.execute('review_investment',{findings:[{claimId:'C1',verdict:'source_supported',reason:'W2客户说法',citations:[{sourceId:'W2',quote:'已有20家付费客户'}]}]})).evidence;assert.equal(r.findings[0].verdict,'unverified');assert.deepEqual(r.findings[0].subjectMismatchSourceIds,['W2']);assert(r.criticalGaps.some(g=>g.includes('C1')&&g.includes('W2')));const memo=(await f.execute('build_investment_memo',{recommendation:'continue_diligence',rationale:'本项目的客户说法尚无匹配主体的外部证据，另一家公司网页不能证明本项目有客户。需要补充合同、银行流水及客户访谈，核验主体和收入质量，后续再决定调查方向，不能批准投资或保证收益。'.repeat(2)})).evidence;assert.equal(memo.recommendation,'request_information');
});

test('large JSON numeric money is rejected before lost cents become facts; strings remain exact',async()=>{
 await assert.rejects(()=>fixture({financials:'[{"period":"2025","revenue":90071992547409.91}]'}).execute('analyze_investment_financials'),/大额JSON数字.*字符串或CSV/);const r=(await fixture({financials:'[{"period":"2025","revenue":"90071992547409.91"}]'}).execute('analyze_investment_financials')).evidence;assert.equal(r.records[0].revenue,'90071992547409.91');assert.equal(r.records[0].amountsCents.revenue,'9007199254740991');assert.equal(r.records[0].amountsFixed.revenue,'90071992547409.91');
});


test('public-looking IP on an actual local interface subnet is blocked without changing system settings',async()=>{
 const interfaces={en0:[{address:'193.168.10.144',netmask:'255.255.255.0',family:'IPv4',internal:false}],lo0:[{address:'127.0.0.1',netmask:'255.0.0.0',family:'IPv4',internal:true}]};
 assert.equal(isDirectlyConnectedAddress('193.168.10.144',interfaces),true);assert.equal(isDirectlyConnectedAddress('193.168.10.1',interfaces),true);assert.equal(isDirectlyConnectedAddress('193.168.11.1',interfaces),false);assert.equal(isDirectlyConnectedAddress('8.8.8.8',interfaces),false);
 await assert.rejects(()=>validatePublicUrl('http://193.168.10.1/',{networkInterfaces:interfaces}),/非公开地址/);await assert.rejects(()=>validatePublicUrl('http://193.168.10.144/',{networkInterfaces:interfaces}),/非公开地址/);const publicPage=await validatePublicUrl('https://8.8.8.8/',{networkInterfaces:interfaces});assert.equal(publicPage.addresses[0].address,'8.8.8.8');
});
