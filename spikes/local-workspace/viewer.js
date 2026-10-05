const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const el = (id) => document.getElementById(id);
let state = { status: 'idle' }, imageUrl, busy = false, inputCount = 0, delayed;
async function request(path, body) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? '请求失败');
  return result;
}
function render() {
  const active = ['starting', 'ready'].includes(state.status);
  el('mode').textContent = state.mode === 'real' ? '实机模式：仅操作本次隐藏桌面的窗口' : 'FAKE：合成演示，不启动 Windows 应用';
  el('run').disabled = active;
  el('act').disabled = el('delayed').disabled = state.status !== 'ready' || state.input !== 'NOT_RUN';
  el('stop').disabled = !active;
  el('app').disabled = active;
  el('status').textContent = JSON.stringify(state, null, 2);
  if (!active) {
    el('frame').hidden = true;
    clearTimeout(delayed);
  }
}
async function command(path, body) {
  try { state = await request(path, body); el('notice').textContent = ''; render(); }
  catch (error) { el('notice').textContent = error.message; }
}
el('run').addEventListener('click', () => command('/run', { app: el('app').value }));
el('act').addEventListener('click', () => command('/act', { run_id: state.run_id }));
el('delayed').addEventListener('click', () => {
  const runId = state.run_id;
  el('notice').textContent = '5 秒后运行；现在可在下面输入合成文字。';
  clearTimeout(delayed);
  delayed = setTimeout(() => command('/act', { run_id: runId }), 5000);
});
el('stop').addEventListener('click', () => { clearTimeout(delayed); command('/stop', { run_id: state.run_id }); });
el('parallel').addEventListener('input', () => {
  inputCount++;
  el('parallel-count').textContent = `本页收到 ${inputCount} 次输入事件；未读取、发送或保存输入文字。人工结果需单独确认。`;
});
async function poll() {
  if (busy) return;
  busy = true;
  try {
    state = await request('/status'); render();
    if (['starting', 'ready'].includes(state.status)) {
      const response = await fetch('/frame', { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 200) {
        const next = URL.createObjectURL(await response.blob());
        el('frame').src = next; el('frame').hidden = false;
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = next;
      }
    }
  } catch (error) { el('notice').textContent = error.message; }
  finally { busy = false; }
}
poll(); setInterval(poll, 200);
