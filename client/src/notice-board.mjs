import {escapeHtml as e,dateText} from './erp-ui.mjs';

const action=(label,name,id='',primary=false)=>`<button type="button" class="erp-button ${primary?'erp-primary':''}" data-erp-action="${name}" ${id?`data-id="${e(id)}"`:''}>${label}</button>`;

export function renderPublicNotices({notices=[],selectedId,canPublish=false}={}){
 const rows=notices.filter(item=>item.archived!==true),selected=rows.find(item=>item.id===selectedId)||rows[0];
 return `<section class="office-notices"><div class="erp-section-head"><h2>公司公告</h2>${canPublish?action('发布公告','new-notice','',true):''}</div>${!rows.length?'<div class="erp-empty">暂无公告</div>':`<div class="office-notice-layout"><nav class="office-notice-list" aria-label="公司公告">${rows.map(item=>`<button type="button" class="office-notice-item" data-erp-action="select-notice" data-id="${e(item.id)}" ${item.id===selected.id?'aria-current="true"':''}><strong>${e(item.title)}</strong><time>${e(dateText(item.createdAt))}</time></button>`).join('')}</nav><article class="office-notice-article"><div class="office-notice-title"><h2>${e(selected.title)}</h2>${canPublish?action('编辑','edit-notice',selected.id):''}</div><div class="office-notice-meta"><span>${e(selected.authorName)}</span><time>${e(dateText(selected.createdAt))}</time>${selected.version>1?`<span>更新于 ${e(dateText(selected.updatedAt))}</span>`:''}</div><div class="office-notice-body">${e(selected.body)}</div></article></div>`}</section>`;
}

export function renderNoticeForm(notice){
 return `<form class="erp-form office-notice-form" data-erp-form="notice" ${notice?`data-id="${e(notice.id)}" data-version="${e(notice.version)}"`:''}><label class="erp-field"><span>标题<small>必填</small></span><input name="title" maxlength="80" value="${e(notice?.title||'')}" required></label><label class="erp-field"><span>正文<small>必填</small></span><textarea name="body" maxlength="5000" rows="10" required>${e(notice?.body||'')}</textarea></label><div class="erp-form-footer">${action('取消','back')}<button type="submit" class="erp-button erp-primary">${notice?'保存修改':'发布'}</button></div></form>`;
}
