import type { ComputerAction } from "../actions/schema.js";
import type { WindowInfo } from "../runtime/desktop/desktop-runtime.js";
import type { CompletionCriteria } from "../verifier/verifier.js";
import type { TaskRequest } from "./task.js";
import type { ObservationFacetProvider } from "./facets.js";
import type { VerifierContributor } from "./verifier-contributor.js";

/**
 * 应用场景约束：为通用任务提供窗口选择、动作边界与独立完成条件。
 * 具体业务配置通过 AgentExtension.profiles 注册，核心只消费匹配结果。
 */
export interface TaskProfile {
  id: string;
  matches(goal: string): boolean;
  target?(goal: string): string;
  constraint?: string;
  allowedActions?: ComputerAction["kind"][];
  requireTargetedScroll?: boolean;
  environment?: "browser" | "windows";
  selectWindows?(windows: readonly WindowInfo[]): WindowInfo[];
  completionCriteria?: CompletionCriteria;
}

/** 专用任务能力：命中后直接走扩展执行器，不进通用主线。 */
export interface SpecializedTaskCapability {
  readonly id: string;
  /** 多个能力命中同一目标时的优先级；数值大者优先，默认 0。 */
  readonly priority?: number;
  matches(goal: string): boolean;
  prepare(goal: string, options: { admin?: boolean }): TaskRequest;
  /**
   * 创建任务记录并排队执行；返回任务 ID。
   * 实现必须在任务记录（Trace 状态）中写入本能力 id（state.executorId），
   * 供核心在恢复时按执行器身份路由，而不是按目标文本重新匹配。
   */
  submit(request: TaskRequest, enqueue: (task: () => Promise<void>) => void): string;
  /** 恢复专用任务；enqueue 由调用方提供，避免扩展持有队列生命周期。 */
  resume?(taskId: string, response: { approved?: boolean; answer?: string },
    enqueue: (task: () => Promise<void>) => void): void;
}

/**
 * 业务扩展单元：注册专用能力与场景配置，声明依赖并返回释放行为。
 * 扩展不进入核心 import 图；核心通过 ExtensionRegistry 发现它们。
 */
export interface AgentExtension {
  readonly id: string;
  readonly name?: string;
  readonly capabilities?: readonly SpecializedTaskCapability[];
  readonly profiles?: readonly TaskProfile[];
  /** 扩展注册的业务无关域证据采集器（facet provider）。 */
  readonly facets?: readonly ObservationFacetProvider[];
  /** 扩展注册的域验收贡献者；只能消费核心已绑定的当次 facet 证据。 */
  readonly contributors?: readonly VerifierContributor[];
  /** 依赖的扩展 ID；注册时缺失则拒绝，撤销时级联撤销。 */
  readonly dependsOn?: readonly string[];
  dispose?(): void | Promise<void>;
}

/**
 * 扩展注册表：唯一入口是注册/撤销，路由只读取匹配结果。
 * 语义：
 * - 重复注册同一扩展 ID 报错；
 * - 依赖缺失时报错；
 * - 撤销注册先使扩展对新路由不可见，再级联撤销依赖它的扩展，最后等待异步 dispose；
 *   dispose 抛错不中断卸载，错误在卸载完成后上报（卸载结果仍是已撤销）；
 * - 能力冲突按 priority 降序、注册序优先；
 * - 无匹配时返回 undefined，调用方走通用兜底；
 * - 能力归属可查：capabilityById 按 id 精确查找（恢复路由），ownerOf 返回所属扩展。
 */
export class ExtensionRegistry {
  private readonly extensions = new Map<string, AgentExtension>();
  private readonly capabilityOrder: SpecializedTaskCapability[] = [];
  private readonly profileOrder: TaskProfile[] = [];
  private readonly facetProviders: ObservationFacetProvider[] = [];
  private readonly verifierContributors: VerifierContributor[] = [];

  register(extension: AgentExtension): void {
    if (this.extensions.has(extension.id)) throw new Error(`扩展 ${extension.id} 已注册`);
    for (const dep of extension.dependsOn ?? []) {
      if (!this.extensions.has(dep)) throw new Error(`扩展 ${extension.id} 缺少依赖 ${dep}`);
    }
    // 能力与场景配置 ID 全局唯一：同名能力会造成 capabilityById/ownerOf 归属歧义，
    // 卸载一个扩展会连带删除另一个扩展的同名能力。
    for (const capability of extension.capabilities ?? []) {
      if (this.capabilityOrder.some((item) => item.id === capability.id)) {
        throw new Error(`能力 ${capability.id} 已被其他扩展声明`);
      }
    }
    for (const profile of extension.profiles ?? []) {
      if (this.profileOrder.some((item) => item.id === profile.id)) {
        throw new Error(`场景配置 ${profile.id} 已存在`);
      }
    }
    for (const facet of extension.facets ?? []) {
      if (this.facetProviders.some((item) => item.id === facet.id)) {
        throw new Error(`Facet provider ${facet.id} 已被其他扩展声明`);
      }
    }
    for (const contributor of extension.contributors ?? []) {
      if (this.verifierContributors.some((item) => item.id === contributor.id)) {
        throw new Error(`验收贡献者 ${contributor.id} 已被其他扩展声明`);
      }
    }
    this.extensions.set(extension.id, extension);
    this.capabilityOrder.push(...(extension.capabilities ?? []));
    this.profileOrder.push(...(extension.profiles ?? []));
    this.facetProviders.push(...(extension.facets ?? []));
    this.verifierContributors.push(...(extension.contributors ?? []));
  }

  async unregister(id: string): Promise<boolean> {
    const extension = this.extensions.get(id);
    if (!extension) return false;
    // 1) 先使扩展对新路由不可见：阻止新任务/新输入命中已卸载的能力与配置。
    this.extensions.delete(id);
    this.removeOrders(extension);
    // 2) 级联撤销依赖者（保持“注册集合始终满足依赖”不变量）；依赖者先释放。
    const errors: unknown[] = [];
    for (const dependent of [...this.extensions.values()]) {
      if ((dependent.dependsOn ?? []).includes(id)) {
        try { await this.unregister(dependent.id); } catch (error) { errors.push(error); }
      }
    }
    // 3) 最后释放资源；等待异步 dispose，错误在卸载完成后上报。
    try { await extension.dispose?.(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw errors[0];
    return true;
  }

  async clear(): Promise<void> {
    const errors: unknown[] = [];
    for (const id of [...this.extensions.keys()]) {
      try { await this.unregister(id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "扩展释放失败");
  }

  has(id: string): boolean {
    return this.extensions.has(id);
  }

  listExtensions(): readonly AgentExtension[] {
    return [...this.extensions.values()];
  }

  /** 按能力 id 精确查找（不受当前匹配规则影响）；用于按持久化身份恢复专用任务。 */
  capabilityById(id: string): SpecializedTaskCapability | undefined {
    return this.capabilityOrder.find((item) => item.id === id);
  }

  /** 能力归属：返回声明该能力的扩展 id（未被注册的扩展直接返回 undefined）。 */
  ownerOf(capabilityId: string): string | undefined {
    for (const [extensionId, extension] of this.extensions) {
      if ((extension.capabilities ?? []).some((item) => item.id === capabilityId)) {
        return extensionId;
      }
    }
    return undefined;
  }

  /** 按 priority 降序、注册序优先返回第一个命中能力；prepare 抛错向上传播。 */
  resolveCapability(goal: string, options: { admin?: boolean } = {}):
    { capability: SpecializedTaskCapability; request: TaskRequest } | undefined {
    const sorted = [...this.capabilityOrder].sort((a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0));
    for (const capability of sorted) {
      if (capability.matches(goal)) return { capability, request: capability.prepare(goal, options) };
    }
    return undefined;
  }

  /** 只按匹配返回能力，不执行 prepare；用于旧任务（无 executorId）的兼容恢复路由。 */
  matchCapability(goal: string): SpecializedTaskCapability | undefined {
    const sorted = [...this.capabilityOrder].sort((a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0));
    return sorted.find((item) => item.matches(goal));
  }

  /** 返回第一个命中场景配置；注册序优先。 */
  profileFor(goal: string): TaskProfile | undefined {
    for (const profile of this.profileOrder) {
      if (profile.matches(goal)) return profile;
    }
    return undefined;
  }

  /** 已注册的全部 facet provider（装配层据此构造 FacetRegistry）。 */
  listFacetProviders(): readonly ObservationFacetProvider[] {
    return this.facetProviders;
  }

  /** 已注册的全部验收贡献者（装配层据此构造 ContributorRegistry）。 */
  listVerifierContributors(): readonly VerifierContributor[] {
    return this.verifierContributors;
  }

  private removeOrders(extension: AgentExtension): void {
    const capabilityIds = new Set((extension.capabilities ?? []).map((item) => item.id));
    const profileIds = new Set((extension.profiles ?? []).map((item) => item.id));
    const facetIds = new Set((extension.facets ?? []).map((item) => item.id));
    const contributorIds = new Set((extension.contributors ?? []).map((item) => item.id));
    for (let index = this.capabilityOrder.length - 1; index >= 0; index--) {
      if (capabilityIds.has(this.capabilityOrder[index].id)) this.capabilityOrder.splice(index, 1);
    }
    for (let index = this.profileOrder.length - 1; index >= 0; index--) {
      if (profileIds.has(this.profileOrder[index].id)) this.profileOrder.splice(index, 1);
    }
    for (let index = this.facetProviders.length - 1; index >= 0; index--) {
      if (facetIds.has(this.facetProviders[index].id)) this.facetProviders.splice(index, 1);
    }
    for (let index = this.verifierContributors.length - 1; index >= 0; index--) {
      if (contributorIds.has(this.verifierContributors[index].id)) this.verifierContributors.splice(index, 1);
    }
  }
}
