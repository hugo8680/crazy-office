import {defineConfig,loadEnv} from 'vite';
function officePages(req,res,next){
  const [pathname,query]=String(req.url||'/').split('?');
  if(pathname==='/login'||pathname==='/join')req.url=`${pathname}.html${query===undefined?'':`?${query}`}`;
  next();
}
const pages={name:'office-pages',configureServer(server){server.middlewares.use(officePages);},configurePreviewServer(server){server.middlewares.use(officePages);}};
export default defineConfig(({mode})=>{
  const local=loadEnv(mode,import.meta.dirname,'OFFICE_API_');
  const target=process.env.OFFICE_API_TARGET||local.OFFICE_API_TARGET||'http://127.0.0.1:8080';
  const api={target,changeOrigin:false,ws:false,timeout:180000,proxyTimeout:180000};
  return {root:'src',publicDir:false,plugins:[pages],server:{proxy:{'/api':api}},preview:{proxy:{'/api':api}},build:{outDir:'../dist',emptyOutDir:true}};
});
