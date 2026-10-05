import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { byteHash } from './sidecar.js';

export function saveRaw(path:string,value:unknown) {
  const fd=openSync(path,'wx');
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
}
export function appendRaw(path:string,value:unknown) {
  const fd=openSync(path,'a');try{appendFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
}
export function artifactHashes(root:string):Record<string,string> {
  const walk=(dir:string):string[]=>readdirSync(dir).flatMap(n=>{
    const p=resolve(dir,n);return statSync(p).isDirectory()?walk(p):[p];
  });
  return Object.fromEntries(walk(root).map(p=>[relative(root,p).replaceAll('\\','/'),byteHash(readFileSync(p))]));
}
