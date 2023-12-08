import { listen } from "listhen";
import consola from 'consola'
import { createIPX, createIPXNodeServer, ipxFSStorage, ipxHttpStorage } from "./index";



async function bootatrap(){
  const ipx = createIPX({
    storage: ipxFSStorage(),
    maxAge:60*60*24*30,
    httpStorage: ipxHttpStorage({
      domains: ["*.picsum.photos",'*.tgjogo.com'],
    }),
  });
  const app=await listen(createIPXNodeServer(ipx),{
    port:process.env.PROT||4000,
    hostname:'0.0.0.0',
    isProd:true,
    qr:false
  });
  consola.log(`strat is ${app.url}`)
}
bootatrap()
