import {readFileSync} from 'node:fs';
import {requiredEndpoint} from '../agent/local-config.js';
import {resolve} from 'node:path';
import {VerificationEngine} from './engine.js';
import {enrichQuestions} from './semantic-context.js';
import {JevSemanticVerifier} from './jev.js';
import type {AuxiliaryVerifier,VerificationInput,VerificationReport} from './contracts.js';

export interface LiveShadowOptions {baseUrl:string;apiKey:string;instructions:()=>string;
  maxModelBytes?:number;modelTimeoutMs?:number;model?:AuxiliaryVerifier}
export function createLiveShadowVerifier(options:LiveShadowOptions):(input:VerificationInput)=>Promise<VerificationReport> {
  const policy={maxModelBytes:options.maxModelBytes??24000,modelTimeoutMs:options.modelTimeoutMs??2500,
    allowModelPass:false};
  const model=options.model??new JevSemanticVerifier({...options,inputMode:'full'});
  return async input=>{
    // First pass requires no network. Missing, partial, conflicting or stale evidence cannot be repaired by JEV.
    const rules=await new VerificationEngine(policy).verify(input);
    const pending=rules.checks.filter(c=>c.verdict==='unknown');
    if(rules.verdict!=='unknown'||!pending.length||pending.some(c=>c.reason!=='semantic_judgment_required'))return rules;
    const enriched:AuxiliaryVerifier={evaluate:(questions,signal)=>{
      const rich=enrichQuestions(questions,input,rules,5000);
      if(Buffer.byteLength(JSON.stringify(rich))>policy.maxModelBytes)throw new Error('Shadow evidence exceeds model budget');
      return model.evaluate(rich,signal);
    }};
    return new VerificationEngine(policy,enriched).verify(input);
  };
}

/** Explicit local switch. Missing/off config keeps shadow as rule-only and does not require a JEV key. */
export function configuredLiveShadow(rootDir:string):((input:VerificationInput)=>Promise<VerificationReport>)|undefined {
  let config:{mode?:string;maxModelBytes?:number;modelTimeoutMs?:number};
  try {config=JSON.parse(readFileSync(resolve(rootDir,'config/verification-shadow.json'),'utf8'));}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(config.mode==='off')return;
  if(config.mode!=='shadow')throw new Error('Invalid verification shadow mode');
  let key=process.env.COMPUTER_USE_API_KEY;
  if(!key) {
    try {key=readFileSync(resolve(rootDir,'.env.local'),'utf8').split(/\r?\n/)
      .find(x=>/^\s*COMPUTER_USE_API_KEY\s*=/.test(x))?.replace(/^\s*COMPUTER_USE_API_KEY\s*=\s*/,'').trim()
      .replace(/^(['"])(.*)\1$/,'$2');} catch { /* No key. */ }
  }
  if(!key||key==='YOUR_API_KEY')return;
  return createLiveShadowVerifier({baseUrl:requiredEndpoint('JEV_BASE_URL'),apiKey:key,
    instructions:()=>readFileSync(resolve(rootDir,'prompts/verification-semantic.md'),'utf8'),
    maxModelBytes:config.maxModelBytes,modelTimeoutMs:config.modelTimeoutMs});
}
