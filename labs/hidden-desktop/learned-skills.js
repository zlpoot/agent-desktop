// 共用页面客户端：技能定义和动作顺序来自服务端 JSON，不包含应用操作脚本。
class LearnedSkillClient {
  constructor(request, changed = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.request = request;
    this.changed = changed;
    this.wait = wait;
    this.records = [];
    this.history = [];
    this.definition = null;
    this.summary = null;
    this.running = false;
    this.failed = false;
    this.stale = false;
    this.message = '读取学习记录中…';
    this.pending = null;
  }
  sync(summary) {
    if (!summary) return;
    this.summary = summary;
    this.definition = summary.definition;
    this.bound = summary.bound;
    this.verifiedQuery = summary.values?.verifiedQuery ?? null;
    this.failed = summary.requiresReset;
    if (summary.learningRequired && !this.running) this.message = '尚无可用学习 JSON，请启动应用后点击“学习／重新学习”。';
    else if (this.message === '读取学习记录中…') this.message = '学习 JSON 已加载；可启动应用并绑定当前实例。';
  }
  invalidate(reason) {
    this.stale = true;
    this.bound = false;
    this.verifiedQuery = null;
    this.message = reason;
    this.changed();
  }
  progress() {
    if (!this.pending) return null;
    return { capability: this.pending.capability, purpose: '共用 JSON 执行器',
      elapsedMs: Math.max(0, Date.now() - this.pending.startedAt * 1000) };
  }
  report() {
    return JSON.parse(JSON.stringify({ definition: this.definition, learning: this.summary?.recipe,
      bound: this.bound, records: this.records }));
  }
  async runSkill(id, inputs = {}) {
    if (this.running) throw new Error('正在执行，不能并发调用');
    const operationId = id.startsWith('learn:') ? id.slice(6) : id;
    const skill = this.definition?.operations.find(operation => operation.id === operationId);
    if (!skill && !['learn', 'reset'].includes(id)) throw new Error('未知的 JSON 操作');
    const record = { skill: id, title: (id.startsWith('learn:') ? '学习并验证：' : '') + (skill?.title || (id === 'learn' ? '学习／重新学习' : '清除当前绑定')),
      inputs, calls: [], verification: { status: '执行中' } };
    this.records.push(record);
    this.running = true;
    this.message = record.title + '：执行中';
    this.changed();
    try {
      const start = await this.request('/api/learned/start', { action: id, inputs });
      if (!start.ok) throw new Error(start.error?.code || 'replay-start-failed');
      for (;;) {
        const data = await this.request('/api/learned/status?id=' + encodeURIComponent(start.jobId));
        if (!data.ok) throw new Error(data.error?.code || 'replay-status-failed');
        const job = data.job;
        record.calls = job.calls;
        record.output = job.output;
        record.previewError = job.previewError;
        record.verification = job.verification;
        record.startedAt = job.startedAt;
        record.finishedAt = job.finishedAt;
        this.pending = job.calls.findLast(call => call.status === '执行中') || null;
        if (data.state) this.sync(data.state.learned);
        this.changed();
        if (job.status !== 'running') {
          this.failed = job.status === 'failed';
          this.message = job.verification.evidence
            + (job.previewError ? ` 画面未取得：${job.previewError}，请单独刷新，不要重放动作。` : '');
          if (id === 'learn' || id === 'reset' || id.startsWith('learn:')) this.stale = false;
          break;
        }
        await this.wait(400);
      }
    } catch (error) {
      // 请求中断时后台任务可能仍在运行；不取消、不重发动作，下一次由服务端互斥拒绝。
      this.failed = true;
      record.verification = { status: '失败／结果待核对', evidence: String(error.message || error) };
      this.message = record.verification.evidence + '。请核对现场，不要重复输入。';
    } finally {
      this.running = false;
      this.pending = null;
      this.changed();
    }
    return record;
  }
  async reset() { return this.runSkill('reset'); }
}
