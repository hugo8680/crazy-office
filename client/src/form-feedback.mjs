const FIELD_SELECTOR='input,select,textarea';
const ERROR_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></svg>';

function fieldLabel(field){
  const label=field.getAttribute('aria-label')||field.labels?.[0]?.querySelector('.session-field-label,.field-label,span')?.textContent||field.labels?.[0]?.textContent||'';
  return label.replace(/必填/g,'').trim().slice(0,20);
}

export function fieldValidationMessage(field){
  const state=field.validity||{},label=fieldLabel(field),name=label.length>12?'此项':label||'此项';
  if(state.valueMissing){
    if(field.type==='checkbox'||field.type==='radio')return '请选择后再继续';
    return field.tagName==='SELECT'?`请选择${name}`:`请填写${name}`;
  }
  if(state.typeMismatch)return field.type==='email'?'请填写有效的邮箱地址':field.type==='url'?'请填写完整的网址':'请检查填写格式';
  if(state.tooShort)return `至少填写 ${field.minLength} 个字符`;
  if(state.tooLong)return `最多填写 ${field.maxLength} 个字符`;
  if(state.rangeUnderflow)return `不能小于 ${field.min}`;
  if(state.rangeOverflow)return `不能大于 ${field.max}`;
  if(state.stepMismatch)return field.step==='1'?'请填写整数':'请按要求填写数值';
  if(state.badInput)return '请填写有效的数值';
  if(state.patternMismatch)return field.title||'请检查填写格式';
  if(state.customError)return field.validationMessage||'请检查填写内容';
  return '请检查填写内容';
}

// Delegate once so newly rendered ERP and public-board forms inherit the same
// feedback. Native constraints still block invalid submission and reportValidity.
export function mountFormFeedback({root=document,schedule=callback=>setTimeout(callback,0)}={}){
  const records=new WeakMap();let serial=0,firstInvalid=null,focusQueued=false,destroyed=false;
  const fields=scope=>scope?.querySelectorAll?.('[data-office-invalid]')||[];
  function clearField(field){
    const record=records.get(field);if(!record)return;
    record.hint.remove();field.removeAttribute('data-office-invalid');
    const ids=(field.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==record.hint.id);
    ids.length?field.setAttribute('aria-describedby',ids.join(' ')):field.removeAttribute('aria-describedby');
    if(field.getAttribute('aria-invalid')==='true')record.previousInvalid===null?field.removeAttribute('aria-invalid'):field.setAttribute('aria-invalid',record.previousInvalid);
    records.delete(field);
  }
  function clear(scope=root){for(const field of fields(scope))clearField(field);}
  function show(field){
    let record=records.get(field);
    if(!record){
      const doc=field.ownerDocument,hint=doc.createElement('small'),copy=doc.createElement('span');
      do{hint.id=`office-field-feedback-${++serial}`;}while(doc.getElementById(hint.id));
      hint.className='office-field-feedback';hint.setAttribute('role','status');hint.setAttribute('aria-live','polite');hint.innerHTML=ERROR_ICON;hint.append(copy);
      const anchor=field.closest('.session-input')||field;anchor.insertAdjacentElement('afterend',hint);
      record={hint,copy,previousInvalid:field.getAttribute('aria-invalid')};records.set(field,record);
      const described=(field.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);described.push(hint.id);field.setAttribute('aria-describedby',described.join(' '));
    }
    record.copy.textContent=fieldValidationMessage(field);field.setAttribute('aria-invalid','true');field.setAttribute('data-office-invalid','');
  }
  function invalid(event){
    const field=event.target;if(!field?.matches?.(FIELD_SELECTOR)||!field.form||!field.willValidate)return;
    event.preventDefault();show(field);if(!firstInvalid)firstInvalid=field;
    if(focusQueued)return;focusQueued=true;
    schedule(()=>{focusQueued=false;const target=firstInvalid;firstInvalid=null;if(destroyed||!target?.isConnected||!records.has(target)||!target.getClientRects().length)return;target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',inline:'nearest'});});
  }
  function correct(event){const field=event.target;if(!records.has(field))return;if(field.validity?.valid)clearField(field);else show(field);}
  function reset(event){if(event.target?.tagName==='FORM')clear(event.target);}
  function close(event){if(event.target?.tagName==='DIALOG')clear(event.target);}
  function navigate(event){const action=event.target?.closest?.('[data-session-action]');if(action&&['login','register','close','profile','password','appearance'].includes(action.dataset.sessionAction))clear(action.closest('dialog'));}
  const handlers=[['invalid',invalid],['input',correct],['change',correct],['reset',reset],['submit',reset],['close',close],['click',navigate]];
  for(const [type,handler]of handlers)root.addEventListener(type,handler,true);
  return{clear,destroy(){destroyed=true;firstInvalid=null;clear();for(const [type,handler]of handlers)root.removeEventListener(type,handler,true);}};
}
