/** Build an independent contract from the scenario catalog, not the evaluated candidate or labels. */
export function supplementInput(input, scenarios, supplement) {
  const scenario=scenarios.find(s=>s.id===input.contract.id);
  if(!scenario) throw new Error(`No independent specification: ${input.contract.id}`);
  const result=structuredClone(input);
  const outcome=c=>supplement.outcomes.find(x=>x.object===c.object&&x.field===c.field);
  result.specification={id:scenario.id,scope:scenario.scope,requirements:scenario.checks.map(c=>c.id),
    criteria:scenario.checks.map(c=>({id:c.id,requirement:c.id,object:c.object,field:c.field,sources:[c.source],
      predicate:outcome(c)?.predicate??{op:c.op??'equals',expected:c.expected},...(c.samples?{samples:c.samples}:{})}))};
  for(const c of result.contract.criteria) {
    const definition=outcome(c);
    if(definition && c.predicate.op==='equals' && definition.predicate.success.includes(c.predicate.expected))
      c.predicate=structuredClone(definition.predicate);
  }
  return result;
}
