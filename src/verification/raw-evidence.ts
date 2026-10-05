import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { Evidence, EvidenceSource, Scalar, Verdict } from './contracts.js';

export interface RawCheck { verdict: Verdict; reason: string }
export interface CaptureBinding {
  session: string; object: string; capturedAt: number;
  expectedSession: string; expectedObject: string; now: number; notBefore: number; maxAgeMs: number;
}
export function checkBinding(b: CaptureBinding): RawCheck {
  if(!b.session || !b.object || b.session!==b.expectedSession || b.object!==b.expectedObject)
    return {verdict:'unknown',reason:'unbound_target'};
  if(![b.capturedAt,b.now,b.notBefore,b.maxAgeMs].every(Number.isFinite) || b.maxAgeMs<=0 ||
    b.capturedAt<b.notBefore || b.capturedAt>b.now || b.now-b.capturedAt>b.maxAgeMs)
    return {verdict:'unknown',reason:'invalid_capture_time'};
  return {verdict:'pass',reason:'bound_capture'};
}
/** Adapter boundary: collector must supply identity and completeness, not an LLM-derived text summary. */
export function normalizeFields(binding:CaptureBinding, capture:{id:string;source:EvidenceSource;revision?:string;
  fields:Array<{field:string;value:Scalar;complete:boolean}>}):{evidence:Evidence[];issues:string[]} {
  const checked=checkBinding(binding);
  if(checked.verdict!=='pass')return {evidence:[],issues:[checked.reason]};
  if(!capture.id || !['api','dom','uia','window','file'].includes(capture.source) ||
    new Set(capture.fields.map(f=>f.field)).size!==capture.fields.length ||
    capture.fields.some(f=>!f.field || typeof f.complete!=='boolean' ||
      !(['string','boolean'].includes(typeof f.value)||typeof f.value==='number'&&Number.isFinite(f.value))))
    return {evidence:[],issues:['invalid_raw_fields']};
  return {evidence:capture.fields.map((f,i)=>({id:`${capture.id}:${i}`,session:binding.session,object:binding.object,
    field:f.field,value:f.value,complete:f.complete,source:capture.source,capturedAt:binding.capturedAt,revision:capture.revision})),issues:[]};
}
export function decodeFile(bytes: Uint8Array, encoding: 'utf-8'|'utf-16le'|'utf-16be'='utf-8') {
  // Fatal decoding: replacement characters must not conceal invalid/truncated byte sequences.
  let selected=encoding;
  if(bytes[0]===0xff&&bytes[1]===0xfe) selected='utf-16le';
  if(bytes[0]===0xfe&&bytes[1]===0xff) selected='utf-16be';
  if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf) selected='utf-8';
  try {return {text:new TextDecoder(selected,{fatal:true}).decode(bytes),encoding:selected};}
  catch {return undefined;}
}
const crcTable=Uint32Array.from({length:256},(_,value)=>{
  for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);
  return value>>>0;
});
function crc32(bytes: Buffer): number {
  let crc=0xffffffff;
  for(const byte of bytes) crc=(crc>>>8)^crcTable[(crc^byte)&255];
  return (crc^0xffffffff)>>>0;
}
/** Validate bounded 8-bit RGB/RGBA PNGs, including CRC and scanline payload. Other formats are unknown. */
export function inspectPng(bytes: Buffer): {width:number;height:number;sha256:string}|undefined {
  try {
    if(bytes.length>8_000_000 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return;
    let at=8,width=0,height=0,channels=0,ended=false,idatEnded=false;
    const data:Buffer[]=[];
    while(at<bytes.length) {
      const size=bytes.readUInt32BE(at),end=at+12+size;
      if(end>bytes.length)return;
      const type=bytes.toString('ascii',at+4,at+8),body=bytes.subarray(at+8,at+8+size);
      if(crc32(bytes.subarray(at+4,at+8+size))!==bytes.readUInt32BE(at+8+size))return;
      if(at===8 && type!=='IHDR')return;
      if(type==='IHDR') {
        if(at!==8||size!==13)return;
        width=body.readUInt32BE(0);height=body.readUInt32BE(4);channels=body[9]===2?3:body[9]===6?4:0;
        if(!width||!height||width*height>16_000_000||!channels||body[8]!==8||body[10]||body[11]||body[12])return;
      } else if(type==='IDAT') {if(idatEnded)return;data.push(body);}
      else {
        if(data.length)idatEnded=true;
        if(type==='IEND') {if(size||!data.length||end!==bytes.length)return;ended=true;break;}
        if(type[0]===type[0].toUpperCase()&&type!=='PLTE')return;
      }
      at=end;
    }
    if(!ended)return;
    const stride=width*channels+1,expected=stride*height;
    const pixels=inflateSync(Buffer.concat(data),{maxOutputLength:expected});
    if(pixels.length!==expected)return;
    for(let i=0;i<height;i++)if(pixels[i*stride]>4)return;
    return {width,height,sha256:createHash('sha256').update(bytes).digest('hex')};
  } catch {return;}
}
export interface Rect {x:number;y:number;width:number;height:number}
export function checkFrame(bytes:Buffer, metadata:{sha256?:string;width?:number;height?:number;
  captureType?:string;captureRect?:Rect;desktopRect?:Rect;binding?:CaptureBinding}):RawCheck {
  const png=inspectPng(bytes);
  if(!png)return {verdict:'unknown',reason:'invalid_or_unsupported_png'};
  if(metadata.sha256 && metadata.sha256!==png.sha256 || metadata.width!==undefined&&metadata.width!==png.width ||
    metadata.height!==undefined&&metadata.height!==png.height) return {verdict:'unknown',reason:'image_metadata_mismatch'};
  if(metadata.binding) {const bound=checkBinding(metadata.binding);if(bound.verdict!=='pass')return bound;}
  if(metadata.captureType==='window')return {verdict:'fail',reason:'window_is_not_full_desktop'};
  const a=metadata.captureRect,b=metadata.desktopRect;
  if(!a||!b)return {verdict:'unknown',reason:'missing_capture_geometry'};
  if([a,b].some(r=>![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0))
    return {verdict:'unknown',reason:'invalid_capture_geometry'};
  if(a.width!==png.width||a.height!==png.height)return {verdict:'unknown',reason:'pixel_geometry_mismatch'};
  if(a.x!==b.x||a.y!==b.y||a.width!==b.width||a.height!==b.height)return {verdict:'fail',reason:'incomplete_desktop_coverage'};
  if(!metadata.binding)return {verdict:'unknown',reason:'missing_capture_binding'};
  return {verdict:'pass',reason:'full_desktop_geometry_confirmed'};
}
