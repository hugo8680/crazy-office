import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPublicNotices,renderNoticeForm} from '../src/notice-board.mjs';

test('notices remain plain text and archived content is not presented as current company news',()=>{
 const notice={id:'n" onclick="bad',title:'<script>公告</script>',body:'第一行\n<img src=x onerror=bad>',authorName:'<发布人>',createdAt:'2026-10-21T01:00:00Z',version:1};
 const html=renderPublicNotices({notices:[notice,{...notice,id:'archived',title:'已归档秘密',archived:true}],canPublish:false});
 assert.doesNotMatch(html,/<script>|<img|已归档秘密|data-erp-action="(?:new|edit)-notice"/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;发布人&gt;/);assert.match(html,/第一行\n&lt;img/);
 assert.match(renderPublicNotices({}),/暂无公告/);
 assert.match(renderPublicNotices({canPublish:true}),/发布公告/);
 assert.match(renderNoticeForm(notice),/maxlength="80"/);assert.match(renderNoticeForm(notice),/maxlength="5000"/);assert.doesNotMatch(renderNoticeForm(notice),/<script>|<img/);
});
