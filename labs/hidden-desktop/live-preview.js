// 按需拉取最新 PNG；一条在途请求，没有截图队列、自动输入或租约续期。
class LivePreviewClient {
  constructor(request, present, status, session) {
    this.request = request;
    this.present = present;
    this.status = status;
    this.session = session;
    this.pending = false;
    this.enabled = true;
    this.suspended = false;
    this.generation = 0;
  }
  resume() { this.suspended = false; }
  invalidate() { this.generation++; }
  setEnabled(enabled) { this.enabled = enabled; this.resume(); this.invalidate(); }
  async capture(manual = false) {
    if (this.pending || ((!this.enabled || this.suspended) && !manual)) return false;
    if (manual) this.resume();
    const generation = this.generation;
    this.pending = true;
    try {
      const response = await this.request('/api/preview/live', {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-Lab': '1'}, body: '{}'
      });
      if (!response.ok) {
        const data = await response.json();
        const reason = data.error?.code || 'preview-request-failed';
        if (!['preview-busy', 'preview-rate-limited', 'preview-unrendered'].includes(reason)) this.suspended = true;
        this.status(reason === 'preview-unrendered' ? '等待窗口渲染…' : `画面${this.suspended ? '已暂停' : '等待'}：${reason}`);
        return false;
      }
      const info = JSON.parse(response.headers.get('X-Lab-Frame'));
      const blob = await response.blob();
      if (!info || !Number.isInteger(info.width) || !Number.isInteger(info.height)
          || info.width < 1 || info.height < 1 || info.width > 2048 || info.height > 2048
          || !Number.isInteger(info.sequence) || !Number.isFinite(info.capturedAtNs)
          || blob.type !== 'image/png' || blob.size !== info.bytes || blob.size > 4194304 || blob.size < 24) {
        throw new Error('preview-frame-invalid');
      }
      if (generation !== this.generation || info.instanceId !== this.session()) return false;
      await this.present(info, blob);
      this.status(`${this.enabled ? '实时帧' : '单次画面'} #${info.sequence} · ${this.enabled ? '约每秒更新 · ' : ''}内存保留最近 2 帧`);
      return true;
    } catch (error) {
      this.suspended = true;
      this.status('画面已暂停：' + String(error.message || error) + '，可单独刷新重试。');
      return false;
    } finally {
      this.pending = false;
    }
  }
}
