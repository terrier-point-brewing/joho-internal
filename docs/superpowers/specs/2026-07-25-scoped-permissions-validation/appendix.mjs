import { readFileSync } from "fs";
import { scopeFor } from "./scopes.js";
const src = readFileSync("verify.mjs","utf8");
const GROUP_LEVEL = eval("("+src.match(/const GROUP_LEVEL = (\{[\s\S]*?\n\});/)[1]+")");
const OV = eval("("+src.match(/const ROUTE_OVERRIDE = (\[[\s\S]*?\n\]);/)[1]+")");
const rows = readFileSync("audit94.txt","utf8").trim().split("\n").map(l=>{
  const [route,method,lr]=l.split("|"); const legacy=lr?lr.split(","):[];
  const scope=scopeFor(route); const path=route.replace(/\/route\.ts$/,"");
  let lvl=GROUP_LEVEL[`${scope}|${legacy.join(",")}`];
  if(typeof lvl==="function") lvl=lvl(method);
  for(const [re,m,v] of OV) if(re.test(path)&&m===method) lvl=v;
  return {path,method,legacy,scope,level:lvl};
});
const by=new Map();
for(const r of rows){ if(!by.has(r.scope)) by.set(r.scope,[]); by.get(r.scope).push(r); }
let out="";
for(const [scope,rs] of [...by.entries()].sort()){
  out+=`\n#### \`${scope}\` — ${rs.length} routes\n\n`;
  out+="| Method | Route | Legacy | Level |\n|---|---|---|---|\n";
  for(const r of rs.sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method)))
    out+=`| ${r.method} | \`${r.path}\` | \`[${r.legacy.join(", ")}]\` | \`${r.level}\` |\n`;
}
console.log(out);
