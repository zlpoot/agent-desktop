import { saveModelSettings } from '../../src/agent/model-settings.js';

/** Local synthetic configuration only; .invalid is never contacted by these UI fixtures. */
export function configureSyntheticModel(directory: string) {
  return saveModelSettings(directory, { endpoint: 'https://synthetic.invalid/v1', model: 'synthetic-ui-model',
    keyAction: 'replace', apiKey: 'synthetic-ui-key-never-real' });
}
