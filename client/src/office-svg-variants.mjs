/* Keep the parsed SVG nodes for the two most recent workplace geometries.
 * Only one variant is attached, so hidden overview desks cannot participate in
 * painting, pointer picking or idle animations alongside the detailed desk. */
export function createOfficeSVGVariants(document,{limit=2}={}) {
  let records=new WeakMap();
  const record=element=>{let value=records.get(element);if(!value){value={current:null,variants:new Map()};records.set(element,value);}return value;};
  function variant(element,key,render){
    const value=record(element);let content=value.variants.get(key);
    if(!content){
      const markup=render();
      if(typeof element.replaceChildren==='function'&&element.childNodes&&document?.createElementNS){
        const host=document.createElementNS('http://www.w3.org/2000/svg','g');host.innerHTML=markup;
        content={nodes:Array.from(host.childNodes)};
      }else content={markup};
      value.variants.set(key,content);
    }
    // LRU bounds retained DOM even after directory or wardrobe changes.
    value.variants.delete(key);value.variants.set(key,content);
    while(value.variants.size>limit){const oldest=[...value.variants.keys()].find(candidate=>candidate!==value.current&&candidate!==key);if(oldest===undefined)break;value.variants.delete(oldest);}
    return content;
  }
  return {
    prime(element,key,render){variant(element,key,render);},
    show(element,key,render){
      const value=record(element);if(value.current===key)return false;
      const content=variant(element,key,render);
      if(content.nodes)element.replaceChildren(...content.nodes);else element.innerHTML=content.markup;
      value.current=key;
      while(value.variants.size>limit){const oldest=[...value.variants.keys()].find(candidate=>candidate!==key);value.variants.delete(oldest);}
      return true;
    },
    clear(){records=new WeakMap();},
  };
}
