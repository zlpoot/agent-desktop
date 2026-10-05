/**
 * cordis@4.0.0-rc.10 的类型声明（本地接管，ambient 形式）。
 *
 * 上游 `lib/*.d.ts` 使用无扩展相对导入（`from './context'`），在项目的
 * `moduleResolution: NodeNext` 下触发 TS2834，导致 `export *` 全部解析失败，
 * 'cordis' 模块在类型层面为空。此处通过 ambient `declare module "cordis"`
 * 接管类型面，覆盖本工程实际使用的 API 子集，并已按 rc.10 真实实现逐一验证
 * （见阶段 B 集成测试）。运行时不受影响：Node/tsx 仍按 package.json exports
 * 解析真实实现。
 *
 * 注意：本文件必须保持纯类型（无顶层 import/export、全部为 declare），
 * tsx/esbuild 会将其完全剥离，绝不参与运行时。
 */

declare module "cordis" {
  export type Dict<T = any> = Record<string, T>;
  export type Awaitable<T> = T | PromiseLike<T>;

  export type Disposable<T = any> = () => T;
  export type SyncEffect<T = any> = Disposable<T> | Iterable<Disposable<T>, void, void>;
  export type AsyncEffect<T = any> = Promise<Disposable<T>> | AsyncIterable<Disposable<T>, void, void>;
  export type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>;

  export const enum FiberState {
    PENDING = 0,
    LOADING = 1,
    ACTIVE = 2,
    FAILED = 3,
    DISPOSED = 4,
    UNLOADING = 5,
  }

  export class CordisError extends Error {
    constructor(code: string, message?: string);
  }

  export class ValidationError extends TypeError {
    constructor(issues: readonly unknown[]);
  }

  export function isBailed(value: any): boolean;

  export const symbols: {
    readonly isolate: unique symbol;
    readonly intercept: unique symbol;
    readonly shadow: unique symbol;
    readonly invoke: unique symbol;
    readonly config: unique symbol;
    readonly check: unique symbol;
    readonly custom: unique symbol;
  };

  export interface EventOptions {
    prepend?: boolean;
    global?: boolean;
  }

  /** 事件表：本工程只使用字符串事件名与任意负载。 */
  export interface Events {
    [key: string]: (...args: any[]) => any;
    [key: symbol]: (...args: any[]) => any;
  }

  export interface PluginBase<T = any> {
    name?: string;
    inject?: string[] | { [K in string]?: any };
    provide?: string | string[];
    intercept?: Dict<boolean>;
  }

  export interface PluginFunction<T = any> extends PluginBase<T> {
    (ctx: Context, config: T): any;
  }

  export interface PluginObject<T = any> extends PluginBase<T> {
    apply(ctx: Context, config: T): any;
  }

  export interface PluginConstructor<T = any> extends PluginBase<T> {
    new (ctx: Context, config: T): any;
  }

  export type Plugin<T = any> = PluginFunction<T> | PluginObject<T> | PluginConstructor<T>;

  export class Fiber {
    parent: Context;
    inject: Dict<any>;
    runtime: unknown;
    uid: number | null;
    readonly ctx: Context;
    config: any;
    state: FiberState;
    readonly dispose: () => Promise<void>;
    effect(execute: () => Effect, label?: string): Disposable<Promise<void>>;
    await(): Promise<this>;
  }

  /** `ctx.plugin(...)` 的返回类型：`Fiber & PromiseLike<Fiber>`。 */
  export interface FiberLike extends PromiseLike<Fiber> {
    readonly ctx: Context;
    state: FiberState;
    dispose(): Promise<void>;
  }

  export interface Context {
    root: Context;
    fiber: Fiber;
    events: { _hooks: Record<string, unknown[]> };
    logger: { error(...args: any[]): void; [key: string]: any };
    reflect: unknown;
    registry: unknown;
    /** 服务与自定义属性（装配层在 services.ts 中按名增强）。 */
    [key: string]: any;
    effect(execute: () => Effect, label?: string): Disposable<Promise<void>>;
    provide(name: string, value?: any, check?: () => boolean): Disposable<Promise<void>>;
    on(name: string, listener: (...args: any[]) => any, options?: boolean | EventOptions): () => boolean;
    once(name: string, listener: (...args: any[]) => any, options?: boolean | EventOptions): () => boolean;
    emit(name: string, ...args: any[]): void;
    plugin<P extends Plugin>(plugin: P, ...args: any[]): FiberLike;
    inject(deps: string[], callback: PluginFunction<void>): FiberLike;
    set(name: string, value: any): void;
    get(name: string, strict?: boolean): any;
  }

  export class Context {
    constructor();
  }
}
