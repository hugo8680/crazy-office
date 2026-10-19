import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {reportDocument} from '../server/report-document.mjs';
import {createToolbox} from '../server/tools.mjs';

async function savedReport(content, verify, title='任务交付报告') {
  const runDir=await fs.mkdtemp(path.join(os.tmpdir(),'office-report-document-'));
  try {
    const box=await createToolbox({runDir,input:{},approval:async()=>({approved:false})});
    const result=await box.execute('write_report',{title,content},'lead');
    const html=await fs.readFile(path.join(runDir,result.files.find(file=>file.endsWith('.html'))),'utf8');
    const markdown=await fs.readFile(path.join(runDir,result.files.find(file=>file.endsWith('.md'))),'utf8');
    await verify({html,markdown,result,artifacts:box.artifacts()});
  } finally {
    await fs.rm(runDir,{recursive:true,force:true});
  }
}

const evidence='本次报告仅描述工作区内的实际工具结果。真实业务数据尚未提供，验证记录不冒充公司经营事实；外部系统未修改，采购、付款与生产发布仍需要真实员工确认。';

test('standalone report is offline, mobile readable, and prints complete tables on A4',()=>{
  const body='<p>正文保持原样。</p><div class="table-wrap"><table><thead><tr><th>金额</th></tr></thead><tbody><tr><td>120.30</td></tr></tbody></table></div>';
  const html=reportDocument({title:'经营情况汇报',body});
  assert.match(html,/^<!doctype html>/);
  assert.match(html,/<html lang="zh-CN">/);
  assert.match(html,/<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html,/default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'/);
  assert.ok(html.includes(body));
  assert.match(html,/@page\{size:A4;/);
  assert.match(html,/@media print\{/);
  assert.match(html,/\.table-wrap\{overflow:visible;/);
  assert.match(html,/thead\{display:table-header-group\}/);
  assert.doesNotMatch(html,/<(?:script|link|img|iframe)\b|@import|url\(|(?:box|text)-shadow|gradient\(/i);
});

test('the document title is escaped independently from the trusted rendered fragment',()=>{
  const title='结论 </title><svg onload="alert(1)"> & \'审查\'';
  const fragment='<p>&lt;script&gt;保留为文字&lt;/script&gt;</p>';
  const html=reportDocument({title,body:fragment});
  assert.equal((html.match(/<h1>/g)||[]).length,1);
  assert.match(html,/&lt;\/title&gt;&lt;svg onload=&quot;alert\(1\)&quot;&gt; &amp; &#39;审查&#39;/);
  assert.doesNotMatch(html,/<svg|<script/);
  assert.ok(html.includes(fragment));
  assert.doesNotMatch(html,/&amp;lt;script/);
  assert.throws(()=>reportDocument({title,body:{html:fragment}}),TypeError);
});

test('real report tool keeps the CRLF source, files, and factual receipt while rendering one main title',async()=>{
  const title='数据库 <验证> & 交付',content='# '+title+'\r\n\r\n## 实际结果\r\n\r\n'+evidence+'\r\n\r\n核验金额：120.30，样本行数：3，生产数据行数：0。';
  await savedReport(content,({html,markdown,result,artifacts})=>{
    assert.equal(markdown,content+'\n');
    assert.equal((html.match(/<h1>/g)||[]).length,1);
    assert.match(html,/<h1>数据库 &lt;验证&gt; &amp; 交付<\/h1>/);
    assert.ok(html.includes('120.30，样本行数：3，生产数据行数：0'));
    assert.equal(result.evidence.characters,content.length);
    assert.equal(result.evidence.sentExternally,false);
    assert.equal(result.files.length,2);
    assert.deepEqual(artifacts.map(file=>file.mimeType).sort(),['text/html; charset=utf-8','text/markdown; charset=utf-8']);
  },title);
});

test('code fences preserve shorter fences, HTML, list markers, and links as literal code',async()=>{
  const code='SELECT \'<script>\' AS literal;\n```\n- 不作为列表解析\nhttps://example.com/code';
  await savedReport('## SQL 与证据\n\n````sql\n'+code+'\n````\n\n'+evidence,({html})=>{
    const rendered=html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
    assert.equal(rendered,'SELECT &#39;&lt;script&gt;&#39; AS literal;\n```\n- 不作为列表解析\nhttps://example.com/code');
    assert.doesNotMatch(rendered,/<li>|<a |<script>/);
    assert.match(html,/<\/pre>\s*<p>本次报告/);
  });
});

test('ordered list numbers, list transitions, and later headings remain separate',async()=>{
  const content='- 已保存实际证据\n- 尚未取得外部授权\n3. 核对来源\n7. 真人决定\n\n# 后续工作\n\n'+evidence;
  await savedReport(content,({html,markdown})=>{
    assert.match(html,/<ul>\s*<li>已保存实际证据<\/li>\s*<li>尚未取得外部授权<\/li>\s*<\/ul>\s*<ol start="3">/);
    assert.match(html,/<li value="3">核对来源<\/li>\s*<li value="7">真人决定<\/li>\s*<\/ol>/);
    assert.match(html,/<h2>后续工作<\/h2>/);
    assert.equal((html.match(/<h1>/g)||[]).length,1);
    assert.equal(markdown,'# 任务交付报告\n\n'+content+'\n');
  });
});

test('source links allow only HTTP(S), escape attributes, and never turn raw HTML into active elements',async()=>{
  const content='[来源](https://example.com/quote?x=1&y=2)\n[脚本](javascript:alert(1))\n[页面](data:text/html,malicious)\n[含引号](https://example.com/?q="onmouseover="bad")\n<img src=x onerror="alert(1)">\n官网：https://example.org/source。\n\n'+evidence;
  await savedReport(content,({html})=>{
    assert.match(html,/<a href="https:\/\/example\.com\/quote\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">来源<\/a>/);
    assert.match(html,/<a href="https:\/\/example\.org\/source"[^>]*>https:\/\/example\.org\/source<\/a>。/);
    assert.doesNotMatch(html,/href="(?:javascript|data):|<img\b|<a[^>]*\sonmouseover=/i);
    assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.ok(html.includes('javascript:alert(1)'));
  });
});

test('escaped pipes and pipes inside inline code remain in their original table cells',async()=>{
  const content='| 检查 | 实际记录 |\n| --- | --- |\n| 标签 A\\|B | `SELECT a|b` |\n| 金额 | 120.30 |\n\n'+evidence;
  await savedReport(content,({html})=>{
    const table=html.match(/<table>([\s\S]*?)<\/table>/)?.[1];
    assert.equal((table.match(/<th scope="col">/g)||[]).length,2);
    assert.equal((table.match(/<td>/g)||[]).length,4);
    assert.match(table,/<td>标签 A\|B<\/td><td><code>SELECT a\|b<\/code><\/td>/);
    assert.match(table,/<td>金额<\/td><td>120\.30<\/td>/);
    assert.match(html,/class="table-wrap" role="region" tabindex="0"/);
  });
});

test('unclosed fenced content remains escaped and never swallows already completed lists',async()=>{
  const content='1. 已完成的核查\n\n~~~text\n<script>literal</script>\n\n'+evidence;
  await savedReport(content,({html})=>{
    assert.match(html,/<ol>\s*<li value="1">已完成的核查<\/li>\s*<\/ol>\s*<pre><code>/);
    assert.match(html,/&lt;script&gt;literal&lt;\/script&gt;/);
    assert.doesNotMatch(html,/<script>/);
    assert.ok(html.includes(evidence));
  });
});
