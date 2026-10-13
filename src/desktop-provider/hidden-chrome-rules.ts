import type { ComputerAction } from '../actions/schema.js';
import type { ModelAdapter } from '../agent/model-adapter.js';
import type { ComputerState } from '../graph/state.js';
import { KEY_SUBMIT_SELECTOR, KEY_NAME_SELECTOR, KEY_TOKENS_SELECTOR, KEY_MODEL_PREFIX, type ChromeDiscovery } from './local-workspace-chrome-provider.js';

const url = 'http://192.168.2.3:8102/';
const keyName = 'agent-desktop-hidden-chrome-20261009';
/** Live rules consume the real current DOM projection, never a FakeRuntime or a
 * prerecorded website snapshot. Discovery cannot mark the API Key task done. */
export class InspectKeyForm implements ModelAdapter {
  readonly name = 'LIVE-01 UI discovery rules';
  readonly kind = 'rule';
  async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    if (state.observation?.url === 'about:blank') return { kind: 'navigate', url };
    const discovery = JSON.parse(state.observation?.pageText ?? '{}') as ChromeDiscovery;
    if (discovery.fields?.some(field => field.password)) return { kind: 'ask_user', question: 'BLOCKED_LOGIN: 请在本机完成站点认证；未创建 Key。' };
    const previous = state.recentHistory ?? [];
    if (previous.some(item => item.action.kind === 'click' && item.action.target.kind === 'selector' && item.action.target.selector === '#new-api-key'))
      return { kind: 'ask_user', question: 'BLOCKED_PERMISSION: Key 表单已打开，包含多项勾选授权、必填数值和下拉配置；需确认权限选择，未提交创建。' };
    if (previous.some(item => item.action.kind === 'click' && item.action.target.kind === 'role' && item.action.target.name === '接入权限'))
      return discovery.controls?.some(control => control.id === 'new-api-key' && !control.submit)
        ? { kind: 'click', target: { kind: 'selector', selector: '#new-api-key' } }
        : { kind: 'ask_user', question: 'BLOCKED_DISCOVERY: 接入权限页面已打开；没有唯一非提交的 Key 表单入口。' };
    const navigation = discovery.controls?.filter(control => control.name === '接入权限');
    if (navigation?.length === 1) return { kind: 'click', target: { kind: 'role', role: navigation[0]!.role, name: '接入权限' } };
    return { kind: 'ask_user', question: 'BLOCKED_DISCOVERY: 当前页面缺少唯一可用的接入权限导航，未创建 Key。' };
  }
}

export class CreateOneKey extends InspectKeyForm {
  constructor(private readonly configuredKeyName=keyName) {super();}
  override async decide(state: Readonly<ComputerState>): Promise<ComputerAction> {
    const discovery = JSON.parse(state.observation?.pageText ?? '{}') as ChromeDiscovery;
    if(discovery.apiKeyGenerated) return {kind:'done',summary:'网页已显示新 Key；等待独立本机文件与设置验收'};
    const fields=discovery.fields??[];
    if(fields.some(field=>field.fieldName==='max_output_tokens')) {
      const name=fields.find(field=>field.fieldName==='name');
      if(name?.value!==this.configuredKeyName)return {kind:'type',target:{kind:'selector',selector:KEY_NAME_SELECTOR},text:this.configuredKeyName};
      if(fields.find(field=>field.fieldName==='max_output_tokens')?.value!=='40000')
        return {kind:'type',target:{kind:'selector',selector:KEY_TOKENS_SELECTOR},text:'40000'};
      const model=fields.find(field=>field.fieldName==='allowed_models'&&!field.checked);
      if(model&&Number.isInteger(model.modelIndex))return {kind:'set_checked',target:{kind:'selector',selector:KEY_MODEL_PREFIX+model.modelIndex},checked:true};
      if(!(state.recentHistory??[]).some(item=>item.action.kind==='click'&&item.action.target.kind==='selector'&&item.action.target.selector===KEY_SUBMIT_SELECTOR))
        return {kind:'click',target:{kind:'selector',selector:KEY_SUBMIT_SELECTOR}};
      return {kind:'ask_user',question:'UNKNOWN_CREATE_RESULT: 已发出一次创建，结果尚未确认；禁止再次提交。'};
    }
    return super.decide(state);
  }
}
