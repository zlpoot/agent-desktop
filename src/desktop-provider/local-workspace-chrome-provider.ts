import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, basename } from 'node:path';
import type { DesktopFileSnapshot } from '../verification/file-evidence.js';
import type { Browser, Page } from 'playwright';
import type { ComputerAction, Observation } from '../actions/schema.js';
import type { DesktopProvider, DesktopSession, DesktopSessionIdentity, DesktopCapabilities } from '../contracts/desktop-environment.js';
import type { DesktopInputArbiter, InputAuthority } from '../contracts/desktop-input-control.js';
import type { RuntimeAdapter } from '../runtime/runtime-adapter.js';
import { PlaywrightRuntime } from '../runtime/browser/playwright-runtime.js';
import { sameSession } from './admission.js';

const ORIGIN = 'http://192.168.2.3:8102';
const SAFE_LABELS = ['接入权限', 'API Keys', '生成 API Key', '取消', '关闭', '名称', 'Key 名称',
  'API Key 名称', '调用身份', '身份', '接入工程', '工程', '权限', '有效期', '备注', '过期时间', '模型', '调用额度'];
const SAFE_IDS = ['access-tab', 'new-api-key', 'new-api-key-section', 'profile-search', 'provider-filter',
  'access-project-search', 'access-principal-search', 'access-api-base-url', 'api-key-secret', 'api-key-example',
  'access-secret', 'benchmark-input-preview', 'benchmark-output'];
const SAFE_FIELD_NAMES = ['name', 'allowed_models', 'rpm', 'max_output_tokens', 'days'];
export const KEY_FORM_SELECTOR = 'form:has(input[name="allowed_models"]):has(input[name="max_output_tokens"])';
export const KEY_NAME_SELECTOR = KEY_FORM_SELECTOR+' input[name="name"]';
export const KEY_TOKENS_SELECTOR = KEY_FORM_SELECTOR+' input[name="max_output_tokens"]';
export const KEY_MODEL_PREFIX = KEY_FORM_SELECTOR+' input[name="allowed_models"] >> nth=';
export const KEY_SUBMIT_SELECTOR = KEY_FORM_SELECTOR+' button:is([type="submit"],:not([type]))';
export interface ChromeCreationConfig {
  keyName: string; maxOutputTokens: number; allModels: true;
  /** Durable, exclusive side-effect intent record; must succeed before dispatch. */
  claim(): Promise<void>;
}
/** Only fixed UI vocabulary, authorized form settings and structural metadata leave
 * the browser. No arbitrary values, option text, HTML, screenshots or credentials. */
export const CHROME_DISCOVERY_COLLECTOR = `(() => {
 const allowed = ${JSON.stringify(SAFE_LABELS)};
 const ids = ${JSON.stringify(SAFE_IDS)};
 const names = ${JSON.stringify(SAFE_FIELD_NAMES)};
 const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
 const safe = text => allowed.includes((text || '').trim()) ? text.trim() : '[unrecognized]';
 const modelFields = [...document.querySelectorAll(${JSON.stringify(KEY_FORM_SELECTOR+' input[name="allowed_models"]')})];
 const controls = [...document.querySelectorAll('a,button')].filter(visible).map(e => ({
   role: ['button','link','tab'].includes(e.getAttribute('role')) ? e.getAttribute('role') : e.tagName === 'A' ? 'link' : 'button', name: safe(e.textContent),
   id: ids.includes(e.id) ? e.id : undefined,
   submit: e.tagName === 'BUTTON' && !!e.form && e.type === 'submit'
 })).filter(e => e.name !== '[unrecognized]' || e.submit);
 const fields = [...document.querySelectorAll('input,select,textarea')].filter(visible).map(e => ({
   tag: e.tagName.toLowerCase(), type: e.type, required: e.required,
   id: ids.includes(e.id) ? e.id : '[unrecognized]',
   fieldName: names.includes(e.name) ? e.name : '[unrecognized]',
   value: (['rpm','max_output_tokens','days'].includes(e.name) && /^\\d+$/.test(e.value)) ||
     (e.name === 'name' && /^agent-desktop-hidden-chrome-[0-9]{8}$/.test(e.value)) ? e.value : undefined,
   checked: e.name === 'allowed_models' ? e.checked : undefined,
   modelIndex: e.name === 'allowed_models' ? modelFields.indexOf(e) : undefined,
   label: safe([...e.labels || []].map(l => l.textContent).join(' ').trim()),
   optionCount: e.tagName === 'SELECT' ? e.options.length : undefined,
   password: e.type === 'password'
 }));
 const outputFields = [...document.querySelectorAll('input[readonly],textarea[readonly],pre,code')].map(e => ({
   tag:e.tagName.toLowerCase(),id:ids.includes(e.id)?e.id:'[unrecognized]',visible:visible(e)
 }));
 const key = document.getElementById('api-key-secret');
 return {controls,fields,outputFields,apiKeyGenerated:!!(key && visible(key) && key.textContent.trim().length >= 20)};
})()`;
export interface ChromeDiscovery {
  controls: Array<{ role: string; name: string; id?: string; submit: boolean }>;
  fields: Array<{ tag: string; type: string; required: boolean; id: string; fieldName?: string; label: string;
    optionCount?: number; password: boolean; value?: string; checked?: boolean; modelIndex?: number }>;
  outputFields?: Array<{tag:string;id:string;visible:boolean}>;
  apiKeyGenerated?: boolean;
}

export interface ChromeNativeBackend {
  request<T>(method: string, authority?: InputAuthority): Promise<T>;
  close(): Promise<void>;
}
class Bridge implements ChromeNativeBackend {
  private readonly child: ChildProcessWithoutNullStreams;
  private serial = Promise.resolve();
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(root: string, directory: string, chromePath: string) {
    this.child = spawn('python', [resolve(root, 'spikes/local-workspace/chrome_bridge.py'),
      '--directory', directory, '--chrome', chromePath], { cwd: root, windowsHide: true, stdio: 'pipe' });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const reply = JSON.parse(line);
        const pending = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (reply.error) pending?.reject(new Error('Chrome native bridge: ' + (/^[a-z_]+$/.test(reply.error) ? reply.error : 'request_rejected')));
        else pending?.resolve(reply.result);
      } catch { this.fail(); }
    });
    // Never copy child output to logs: only the fixed JSON protocol may escape.
    this.child.stderr.resume();
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
  }
  private fail() {
    for (const pending of this.pending.values()) pending.reject(new Error('Chrome native bridge disconnected'));
    this.pending.clear();
  }
  request<T>(method: string, authority?: InputAuthority): Promise<T> {
    const task = this.serial.then(() => new Promise<T>((resolveReply, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('Chrome bridge timeout')); }, method === 'start' ? 20000 : 7000);
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolveReply(value as T); },
        reject: error => { clearTimeout(timeout); reject(error); } });
      this.child.stdin.write(JSON.stringify({ id, method, authority }) + '\n', error => {
        if (error) { clearTimeout(timeout); this.pending.delete(id); reject(new Error('Chrome bridge write failed')); }
      });
    }));
    this.serial = task.then(() => {}, () => {});
    return task;
  }
  async close() {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => { this.child.kill(); reject(new Error('Chrome bridge closure unconfirmed')); }, 7000);
      this.child.once('exit', () => { clearTimeout(timeout); done(); });
    });
  }
}

/** Narrow LIVE-01 adapter within the Local Workspace provider family. Default D0
 * fixture/NetEase routing is untouched. Creation requires explicit one-Key settings
 * and durable intent; no Physical Desktop or arbitrary-site execution is admitted. */
export class LocalWorkspaceChromeProvider implements DesktopProvider {
  readonly id = 'windows-local-workspace';
  readonly kind = 'local-workspace' as const;
  private session?: ChromeSession;
  constructor(private readonly input: DesktopInputArbiter, private readonly root: string,
    private readonly chromePath: string, private readonly directory: string) {
    input.registerBackend(binding => !!this.session?.valid(binding), async authority => {
      if (this.session?.matches(authority)) await this.session.drain();
    }, async authority => {
      if (!this.session?.valid(authority)) throw new Error('Chrome session stale');
      await this.session.activate(authority);
    });
  }
  async capabilities(): Promise<DesktopCapabilities> {
    const scope = { providerId: [this.id], environmentKind: [this.kind], application: ['chrome'],
      targetRole: ['owned-page'], action: ['navigate', 'open-key-form', 'configure-key-form', 'create-one-key'], mechanism: ['owned-chrome-cdp'] };
    return { 'input.semantic': [{ state: 'supported', scope }],
      'input.globalInput': [{ state: 'forbidden', scope: {} }],
      'input.rawIsolated': [{ state: 'not-proven', scope: {} }],
      'control.humanTakeover': [{ state: 'unsupported', scope: {} }] };
  }
  async discover() {
    return process.platform === 'win32' ? [{ providerId: this.id, environmentId: 'local-workspace:chrome', kind: this.kind }] : [];
  }
  async open(environmentId: string): Promise<ChromeSession> {
    if (process.platform !== 'win32' || environmentId !== 'local-workspace:chrome' || this.session)
      throw new Error('Explicit Windows Chrome session required');
    const bridge = new Bridge(this.root, this.directory, this.chromePath);
    try {
      const started = await bridge.request<{ binding: DesktopSessionIdentity; port: number; targetId: string;
        hiddenWindowBound: boolean; cdpListenerOwned: boolean }>('start');
      if (started.binding.providerId !== this.id || started.binding.environmentId !== environmentId ||
          !started.binding.instanceId || !started.binding.sessionId || !started.binding.inputResourceId ||
          !started.targetId || !started.hiddenWindowBound || !started.cdpListenerOwned ||
          !Number.isInteger(started.port) || started.port < 1 || started.port > 65535)
        throw new Error('Chrome native handshake invalid');
      this.session = new ChromeSession(started.binding, bridge, started.port, this.input, () => this.capabilities());
      return this.session;
    } catch (error) {
      try { await bridge.request('stop'); } finally { await bridge.close(); }
      throw error;
    }
  }
}

export class ChromeSession implements DesktopSession, RuntimeAdapter {
  readonly name = 'Hidden Workspace Chrome (LIVE-01)';
  readonly providerId: string; readonly environmentId: string; readonly sessionId: string;
  readonly instanceId: string; readonly inputResourceId: string | null;
  private state: 'open' | 'stale' | 'closed' = 'open';
  private authority?: InputAuthority;
  private browser?: Browser;
  private page?: Page;
  private runtime?: PlaywrightRuntime;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatPending = false;
  private closePromise?: Promise<void>;
  private drainPromise?: Promise<void>;
  private sequence = 0;
  private readonly captureEpoch = randomUUID();
  private observedAt = -Infinity;
  private inFlight?: Promise<unknown>;
  discovery?: ChromeDiscovery;
  cleanup?: { ownedJobEmpty: boolean; desktopHandleClosed: boolean };
  nativeFailure?: string;
  keyFileSaved = false;
  private keyOpenerAttempted = false;
  private secretOutputPath?: string;
  private creation?: ChromeCreationConfig;
  private defaults?: {rpm:string;days:string};
  creationDispatched = false;
  authorizeCreation(config: ChromeCreationConfig) {
    if (this.creation || config.allModels !== true || config.maxOutputTokens !== 40000 ||
        !/^agent-desktop-hidden-chrome-[0-9]{8}$/.test(config.keyName)) throw new Error('Chrome creation configuration not authorized');
    this.creation = Object.freeze({...config});
  }
  /** The caller resolves Windows Known Folder Desktop and checks conflicts first. */
  setSecretOutputPath(path: string) { this.secretOutputPath = path; }
  constructor(private readonly binding: DesktopSessionIdentity, private readonly bridge: ChromeNativeBackend,
    private readonly port: number, private readonly input: DesktopInputArbiter,
    readonly capabilities: () => Promise<DesktopCapabilities>,
    private readonly connect: () => Promise<Browser> = async () => {
      const {chromium}=await import('playwright');
      return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    }) {
    this.providerId = binding.providerId; this.environmentId = binding.environmentId;
    this.sessionId = binding.sessionId; this.instanceId = binding.instanceId; this.inputResourceId = binding.inputResourceId;
  }
  matches(binding: DesktopSessionIdentity) { return sameSession(this.binding, binding); }
  valid(binding: DesktopSessionIdentity) { return this.state === 'open' && this.matches(binding); }
  async status() { return { state: this.state, readiness: {} }; }
  async activate(authority: InputAuthority) {
    if (this.authority || authority.owner.kind !== 'agent') throw new Error('Chrome discovery is Agent-only');
    await this.bridge.request('activate', authority);
    this.authority = authority;
  }
  async connectRuntime(authority: InputAuthority): Promise<RuntimeAdapter> {
    this.input.assertAuthority(this, authority);
    if (this.authority !== authority || this.browser) throw new Error('Chrome runtime authority mismatch');
    this.heartbeat = setInterval(() => {
      if (this.state !== 'open') return;
      try { this.input.renewAuthority?.(authority); }
      catch { this.nativeFailure='Chrome Host input heartbeat expired'; void this.close().catch(() => {}); return; }
      // A pending native heartbeat must not suppress the independent Host
      // client's heartbeat. Both original 3-second gates remain in force.
      if (this.heartbeatPending) return;
      this.heartbeatPending = true;
      void this.bridge.request('ping', authority).catch(error => {
        this.nativeFailure = error instanceof Error ? error.message : 'Chrome heartbeat failed';
        return this.close();
      }).catch(() => {}).finally(() => { this.heartbeatPending = false; });
    }, 400);
    await this.guard();
    this.browser = await this.connect();
    const contexts = this.browser.contexts();
    const pages = contexts[0]?.pages();
    if (contexts.length !== 1 || pages?.length !== 1 || pages[0]!.url() !== 'about:blank') throw new Error('Owned fresh Chrome page required');
    this.page = pages[0]!;
    const context = contexts[0]!;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === ORIGIN ? route.continue() : route.abort();
    });
    context.on('page', page => { if (page !== this.page) void this.close().catch(() => {}); });
    this.runtime = PlaywrightRuntime.attach(this.page, { actionTimeoutMs: 1000, navigationTimeoutMs: 12000 });
    return this;
  }
  private assertHostAuthority() {
    if (this.state !== 'open' || !this.authority) throw new Error('Chrome session unavailable');
    this.input.assertAuthority(this, this.authority);
    if (this.page && this.page.url() !== 'about:blank' && new URL(this.page.url()).origin !== ORIGIN)
      throw new Error('Chrome left authorized origin');
  }
  private async guard() {
    this.assertHostAuthority();
    try { await this.bridge.request('check', this.authority); }
    catch (error) { this.state = 'stale'; this.nativeFailure = error instanceof Error ? error.message : 'Chrome native check failed'; throw new Error('Chrome native identity or grant unavailable'); }
    this.assertHostAuthority();
  }
  async observe(): Promise<Observation> {
    await this.guard();
    await this.saveVisibleKey();
    const startedAt = Date.now();
    this.discovery = await this.page!.evaluate(CHROME_DISCOVERY_COLLECTOR) as ChromeDiscovery;
    const rpm = this.discovery.fields.find(field => field.fieldName === 'rpm')?.value;
    const days = this.discovery.fields.find(field => field.fieldName === 'days')?.value;
    if (!this.defaults && rpm !== undefined && days !== undefined) this.defaults = {rpm,days};
    this.assertHostAuthority();
    const pageText = JSON.stringify(this.discovery);
    this.observedAt = performance.now();
    return { url: this.page!.url(), pageText, textEvidence: [{ source: 'dom', text: pageText }],
      capture: { epoch: this.captureEpoch, sequence: ++this.sequence, object: `hidden-chrome:${this.instanceId}`,
        startedAt, finishedAt: Date.now(), clock: 'collector', atomic: false,
        fields: { url: { complete: true, source: 'api' }, pageText: { complete: false, source: 'dom' } } } };
  }
  async ground(action: ComputerAction) { this.assertHostAuthority(); return this.runtime!.ground(action); }
  async resolveAction(action: ComputerAction) { this.assertHostAuthority(); return this.runtime!.resolveAction(action); }
  async execute(action: ComputerAction) {
    this.assertHostAuthority();
    if (this.inFlight || performance.now() - this.observedAt > 2000) throw new Error('Fresh Chrome observation required');
    const observationDeadline=this.observedAt+2000;
    this.observedAt = -Infinity;
    if (action.kind === 'navigate') {
      if (new URL(action.url).origin !== ORIGIN) throw new Error('Origin not authorized');
    } else if (action.kind === 'type' && action.target.kind === 'selector' && this.creation &&
        ((action.target.selector === KEY_NAME_SELECTOR && action.text === this.creation.keyName) ||
         (action.target.selector === KEY_TOKENS_SELECTOR && action.text === String(this.creation.maxOutputTokens)))) {
      if (this.creationDispatched) throw new Error('Chrome creation already dispatched');
    } else if (action.kind === 'set_checked' && action.checked && action.target.kind === 'selector' && this.creation &&
        action.target.selector.startsWith(KEY_MODEL_PREFIX) && /^(0|[1-9][0-9]*)$/.test(action.target.selector.slice(KEY_MODEL_PREFIX.length))) {
      if (this.creationDispatched) throw new Error('Chrome creation already dispatched');
    } else if (action.kind === 'click' && action.target.kind === 'selector' && action.target.selector === KEY_SUBMIT_SELECTOR) {
      if (!this.creation || this.creationDispatched || this.keyFileSaved || !this.defaults) throw new Error('Chrome one-time creation unavailable');
      const values = await this.formConfiguration();
      if (!values || values.keyName !== this.creation.keyName || values.maxOutputTokens !== String(this.creation.maxOutputTokens) ||
          !values.valid || values.models < 1 || !values.allModels || values.rpm !== this.defaults.rpm || values.days !== this.defaults.days)
        throw new Error('Chrome form differs from authorized settings');
      const submit = this.page!.locator(KEY_SUBMIT_SELECTOR);
      if (await submit.count() !== 1 || !await submit.isVisible() || !await submit.isEnabled()) throw new Error('Chrome submit target ambiguous');
      await this.creation.claim();
      this.creationDispatched = true; // Durable intent exists before the sole input dispatch.
    } else if (action.kind === 'click' && action.target.kind === 'selector' && action.target.selector === '#new-api-key') {
      if (!this.secretOutputPath || this.keyOpenerAttempted ||
          !this.discovery?.controls.some(control => control.id === 'new-api-key' && !control.submit && control.name === '生成 API Key'))
        throw new Error('Chrome Key opener not admitted');
      const opener = this.page!.locator('#new-api-key');
      if (await opener.count() !== 1 || await opener.evaluate('e => !!e.closest("form")') ||
          await this.page!.locator('#api-key-secret').isVisible()) throw new Error('Chrome Key opener state ambiguous');
      this.keyOpenerAttempted = true; // Never retry a generation-labeled UI action.
    } else if (action.kind === 'click' && action.target.kind === 'role' &&
        ['link', 'button', 'tab'].includes(action.target.role) && action.target.name === '接入权限') {
      const target = this.page!.getByRole(action.target.role as 'link' | 'button' | 'tab', { name: action.target.name, exact: true });
      if (await target.count() !== 1 || await target.evaluate('e => !!e.closest("form")'))
        throw new Error('Form submission or ambiguous target forbidden during discovery');
    } else throw new Error('Only authorized LIVE-01 Chrome UI actions are supported');
    await this.guard();
    if(performance.now()>=observationDeadline)throw new Error('Chrome observation expired before dispatch');
    const pending = this.runtime!.execute(action);
    this.inFlight = pending;
    try {
      const result = await pending;
      this.assertHostAuthority();
      await this.saveVisibleKey();
      // Drop underlying error details and any incidental observation.
      return { ok: result.ok, effect: result.ok ? 'dispatched' as const : 'uncertain' as const,
        message: result.ok ? 'Owned Hidden Chrome UI action dispatched' : 'Chrome UI action outcome unconfirmed',
        provider: 'browser.playwright.act' };
    } finally { this.inFlight = undefined; }
  }
  private async saveVisibleKey() {
    if (!this.keyOpenerAttempted || this.keyFileSaved || !this.secretOutputPath) return;
    // The only plaintext read has this private local sink. This also handles an
    // asynchronous UI result before the next sanitized observation is collected.
    const output = this.page!.locator('#api-key-secret');
    if (await output.isVisible()) {
      const key = (await output.textContent())?.trim();
      if (!key || !/^[^\s\p{C}*]{20,4096}$/u.test(key)) throw new Error('Chrome Key result incomplete');
      try {
        await writeFile(this.secretOutputPath, key + '\n', { encoding: 'utf8', flag: 'wx' });
        this.keyFileSaved = (await readFile(this.secretOutputPath, 'utf8')) === key + '\n';
      } catch { throw new Error('Chrome Key local file save unconfirmed'); }
      if (!this.keyFileSaved) throw new Error('Chrome Key local file verification failed');
    }
  }
  drain(): Promise<void> {
    return this.drainPromise ??= (async () => {
      clearInterval(this.heartbeat);
      const failures: unknown[] = [];
      // Kill the owned native input resource first: pending CDP effects cannot survive revocation.
      try {
        this.cleanup = await this.bridge.request('stop');
        if (!this.cleanup?.ownedJobEmpty || !this.cleanup.desktopHandleClosed) throw new Error('Native cleanup unconfirmed');
      } catch (error) { failures.push(error); }
      try { await this.browser?.close(); } catch (error) { failures.push(error); }
      try { await this.inFlight; } catch { /* Already cancelled by native teardown. */ }
      if (failures.length) { this.input.blockResource(this); throw new AggregateError(failures, 'Chrome cleanup failed'); }
    })();
  }
  private async formConfiguration(): Promise<{keyName:string;maxOutputTokens:string;rpm:string;days:string;models:number;allModels:boolean;valid:boolean}|undefined> {
    return this.page!.evaluate(`(() => {
      const forms=document.querySelectorAll(${JSON.stringify(KEY_FORM_SELECTOR)});
      if(forms.length!==1)return undefined;
      const form=forms[0];
      const inputs=[...form.querySelectorAll('input,select,textarea')];
      const visible=e=>!!e.getClientRects().length;
      if(inputs.some(e=>visible(e)&&!${JSON.stringify(SAFE_FIELD_NAMES)}.includes(e.name)))return undefined;
      const models=inputs.filter(e=>e.name==='allowed_models');
      const value=name=>form.querySelector('[name="'+name+'"]')?.value;
      const name=value('name');
      return {keyName:/^agent-desktop-hidden-chrome-[0-9]{8}$/.test(name||'')?name:'',
        maxOutputTokens:value('max_output_tokens'),rpm:value('rpm'),days:value('days'),models:models.length,allModels:models.every(e=>e.checked),valid:form.checkValidity()};
    })()`);
  }
  async inspectFile(path: string): Promise<DesktopFileSnapshot> {
    if (!this.secretOutputPath || path.toLowerCase() !== basename(this.secretOutputPath).toLowerCase()) throw new Error('Chrome file scope rejected');
    this.assertHostAuthority();
    const base = {path:this.secretOutputPath,root:dirname(this.secretOutputPath),capturedAt:Date.now(),complete:true};
    try {
      const info=await stat(this.secretOutputPath);
      if(!info.isFile())return {...base,exists:true,kind:'non_file'};
      const content=await readFile(this.secretOutputPath);
      return {...base,exists:true,kind:'file',size:info.size,mtimeMs:info.mtimeMs,
        sha256:createHash('sha256').update(content).digest('hex')}; // Never return plaintext.
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return {...base,exists:false};
      throw new Error('Chrome file observation unavailable');
    }
  }
  /** Independent completion read; compares the current private file to the current
   * bound GUI result. Only booleans cross the verifier/trace boundary. */
  async verifyKeyOutcome(): Promise<{uiConfirmed:boolean;fileMatchesUi:boolean;settingsMatch:boolean}> {
    await this.guard();
    const visible=await this.page!.locator('#api-key-secret').isVisible();
    let matches=false;
    if(visible&&this.secretOutputPath&&this.creationDispatched) {
      const key=(await this.page!.locator('#api-key-secret').textContent())?.trim();
      if(key&&/^[^\s\p{C}*]{20,4096}$/u.test(key)) {
        try {matches=(await readFile(this.secretOutputPath,'utf8'))===key+'\n';} catch { /* Missing evidence stays false. */ }
      }
    }
    const values=await this.formConfiguration();
    const settings=!!(values&&this.creation&&this.defaults&&values.keyName===this.creation.keyName&&
      values.maxOutputTokens===String(this.creation.maxOutputTokens)&&values.models>0&&values.allModels&&
      values.rpm===this.defaults.rpm&&values.days===this.defaults.days);
    this.assertHostAuthority();
    return {uiConfirmed:visible&&this.creationDispatched,fileMatchesUi:matches,settingsMatch:settings};
  }
  async assertArtifactHasNoKey(serialized: string): Promise<void> {
    if(!this.creationDispatched||!this.keyFileSaved)throw new Error('Chrome secret audit requires confirmed local save');
    await this.guard();
    const key=(await this.page!.locator('#api-key-secret').textContent())?.trim();
    if(!key||serialized.includes(key))throw new Error('Chrome private secret artifact audit failed');
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      const failures: unknown[] = [];
      clearInterval(this.heartbeat);
      try { await this.input.revokeSession(this); } catch (error) { failures.push(error); }
      this.state = 'closed';
      try { await this.drain(); } catch (error) { failures.push(error); }
      try { await this.bridge.close(); } catch (error) { failures.push(error); }
      if (failures.length) { this.input.blockResource(this); throw new AggregateError(failures, 'Chrome session close failed'); }
    })();
  }
}
