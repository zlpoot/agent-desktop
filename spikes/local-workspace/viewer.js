const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const el = (id) => document.getElementById(id);
let state = { status: 'idle' }, imageUrl, frame, busy = false, mutation = false, inputCount = 0, delayed;
let pending = [], sending = false;
async function request(path, body) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? '请求失败');
  return result;
}
function humanReady() {
  return !mutation && state.status === 'ready' && state.control_ready && state.owner === 'human';
}
function render() {
  const active = ['starting', 'ready'].includes(state.status);
  const ready = !mutation && state.status === 'ready' && state.control_ready;
  el('mode').textContent = state.mode === 'real' ? '实机模式：仅操作本次隐藏桌面的窗口' : 'FAKE：合成演示，不启动 Windows 应用';
  el('run').disabled = active || mutation;
  el('act').disabled = el('delayed').disabled = !ready || state.owner !== 'agent' || state.script_started || (state.app === 'netease' && !state.input_ready);
  el('takeover').disabled = !ready || state.owner !== 'agent' || !['fixture', 'netease'].includes(state.app) || (state.app === 'netease' && !state.input_ready);
  el('music-option').disabled = !state.netease_available || state.mode !== 'real';
  el('resume').disabled = !humanReady();
  el('stop').disabled = !active || mutation;
  el('app').disabled = active || mutation;
  el('owner').textContent = !active ? '尚未运行 / 已停止' : !state.control_ready ? '切换中：等待旧动作结束，输入禁用' :
    state.owner === 'human' ? `人类控制 · 剩余 ${state.human_remaining} 个事件` : `Agent 控制 · 进度 ${state.agent_progress ?? 0}/${state.agent_total ?? 26}`;
  el('frame').setAttribute('aria-disabled', String(!humanReady()));
  el('status').textContent = JSON.stringify(state, null, 2);
  if (!active) { el('frame').hidden = true; frame = undefined; pending = []; clearTimeout(delayed); }
}
async function command(path, body) {
  mutation = true; render();
  try { state = await request(path, body); el('notice').textContent = ''; }
  catch (error) { el('notice').textContent = error.message; }
  finally { mutation = false; render(); }
}
function transfer(owner) {
  clearTimeout(delayed); pending = [];
  return command('/control', { run_id: state.run_id, epoch: state.epoch, owner });
}
el('run').addEventListener('click', () => command('/run', { app: el('app').value }));
el('act').addEventListener('click', () => command('/act', { run_id: state.run_id, epoch: state.epoch }));
el('takeover').addEventListener('click', () => transfer('human'));
el('resume').addEventListener('click', () => transfer('agent'));
el('delayed').addEventListener('click', () => {
  const runId = state.run_id, epoch = state.epoch;
  el('notice').textContent = '5 秒后运行；现在可在下面输入合成文字。';
  clearTimeout(delayed);
  delayed = setTimeout(() => command('/act', { run_id: runId, epoch }), 5000);
});
el('stop').addEventListener('click', () => { clearTimeout(delayed); pending = []; command('/stop', { run_id: state.run_id }); });
el('parallel').addEventListener('input', () => {
  inputCount++;
  el('parallel-count').textContent = `本页收到 ${inputCount} 次输入事件；未读取、发送或保存输入文字。人工结果需单独确认。`;
});
function queue(event) {
  if (!humanReady()) return;
  if (pending.length >= 16) { el('notice').textContent = '输入队列已满；请等待后重试。'; return; }
  pending.push({ run_id: state.run_id, epoch: state.epoch, event, deadline: performance.now() + 2000 });
  void drain();
}
async function drain() {
  if (sending) return;
  sending = true;
  try {
    while (pending.length) {
      const { deadline, ...body } = pending.shift();
      if (!humanReady() || body.run_id !== state.run_id || body.epoch !== state.epoch || performance.now() >= deadline) continue;
      try { await request('/human', body); }
      catch (error) { pending = []; el('notice').textContent = error.message; }
    }
  } finally { sending = false; }
}
el('frame').addEventListener('click', event => {
  if (!humanReady() || !frame || event.button !== 0) return;
  el('frame').focus();
  const rect = el('frame').getBoundingClientRect(), style = getComputedStyle(el('frame'));
  const left = parseFloat(style.borderLeftWidth), top = parseFloat(style.borderTopWidth);
  const width = rect.width - left - parseFloat(style.borderRightWidth);
  const height = rect.height - top - parseFloat(style.borderBottomWidth);
  const x = Math.floor((event.clientX - rect.left - left) * frame.width / width);
  const y = Math.floor((event.clientY - rect.top - top) * frame.height / height);
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
  queue({ kind: 'click', x, y, ...frame });
});
el('frame').addEventListener('keydown', event => {
  if (!humanReady()) return;
  // Tab/Escape can leave the frame. No modifiers, IME, clipboard or global keys.
  if (event.key === 'Tab' || event.key === 'Escape') return;
  event.preventDefault();
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.repeat) return;
  if (event.key === 'Backspace' || (event.key.length === 1 && /^[\x20-\x7e]$/.test(event.key))) {
    queue({ kind: 'char', value: event.key === 'Backspace' ? '\b' : event.key });
  } else el('notice').textContent = '仅支持合成 ASCII 文字和 Backspace。';
});
el('frame').addEventListener('paste', event => event.preventDefault());
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const nextState = await request('/status');
    // Never replace a newer control response with an older concurrent poll.
    if (!mutation && !(nextState.run_id === state.run_id && nextState.epoch < state.epoch)) { state = nextState; render(); }
    if (['starting', 'ready'].includes(state.status)) {
      const run = state.run_id;
      const response = await fetch('/frame', { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 200) {
        const metadata = { sequence: Number(response.headers.get('X-Frame-Sequence')),
          width: Number(response.headers.get('X-Frame-Width')), height: Number(response.headers.get('X-Frame-Height')) };
        const next = URL.createObjectURL(await response.blob());
        const decoded = new Image(); decoded.src = next; await decoded.decode();
        if (run === state.run_id && ['starting', 'ready'].includes(state.status) && decoded.naturalWidth === metadata.width && decoded.naturalHeight === metadata.height) {
          el('frame').src = next; el('frame').hidden = false; frame = metadata;
          if (imageUrl) URL.revokeObjectURL(imageUrl);
          imageUrl = next;
        } else URL.revokeObjectURL(next);
      }
    }
  } catch (error) { el('notice').textContent = error.message; }
  finally { busy = false; }
}
poll(); setInterval(poll, 200);
