// The company office follows China time, independent of the viewer's device zone.
const officeHour=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'});

export function greetingForPerson({virtual=false,now=new Date()}={}){
  if(virtual===true)return {kind:'robot',text:'随时待命！'};
  const date=now instanceof Date?now:new Date(now);
  if(!Number.isFinite(date.getTime()))return {kind:'human',text:'你好！'};
  const hour=Number(officeHour.format(date));
  const text=hour>=5&&hour<11?'早上好！':hour>=11&&hour<14?'中午好！':hour>=14&&hour<19?'下午好！':'晚上好！';
  return {kind:'human',text};
}
