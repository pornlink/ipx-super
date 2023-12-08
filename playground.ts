import { createIPX, createIPXH3App, ipxFSStorage, ipxHttpStorage } from "./src";

const ipx = createIPX({
  storage: ipxFSStorage(),
  maxAge:60*60*24*30,
  httpStorage: ipxHttpStorage({
    domains: ["*.picsum.photos",'*.tgjogo.com'],
    maxAge:3000
  }),
});

export default createIPXH3App(ipx);
