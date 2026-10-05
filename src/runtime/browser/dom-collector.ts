/**
 * DOM collector 共享脚本（字符串形式，浏览器上下文内执行）。
 *
 * 必须保持字符串常量而非函数：tsx keepNames 会给命名/箭头函数注入 __name helper，
 * 浏览器上下文没有该全局，evaluate 会抛 ReferenceError（见 playwright-runtime 注释）。
 *
 * P9-A4.5 F1（2026-10-02，C0 candidate-budget 治理）：
 * 通用候选预算治理 —— 采集后先做壳层容器去重（li 内含文本相同的已采集交互后代时以交互叶为准），
 * 再按可交互语义优先排序（stable，文档序为 tie-break），最后才截断。
 * 不提高 500 上限、不整体保留空文本 <a>、无站点名/URL 特判、无专用 selector。
 */
export const DOM_COLLECTOR = `(() => {
  const generation = String(performance.timeOrigin);
  const pathOf = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const parent = node.parentElement;
      let index = 1;
      if (parent) {
        const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === node.tagName);
        index = siblings.indexOf(node) + 1;
      }
      parts.unshift(node.tagName.toLowerCase() + '[' + index + ']');
      node = parent;
    }
    parts.unshift('html');
    return parts.join('>');
  };
  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    if (element.tagName === 'SELECT') return 'combobox';
    if (element.tagName === 'INPUT') return element.type === 'checkbox' ? 'checkbox' : 'textbox';
    if (element.tagName === 'TEXTAREA') return 'textbox';
    if (element.tagName === 'LI') return 'listitem';
    if (element.tagName === 'BUTTON') return 'button';
    if (element.tagName === 'A') return 'link';
    return element.tagName.toLowerCase();
  };
  const all = Array.from(document.querySelectorAll(
    'li,[role="row"],input,textarea,select,button,a[href],[role="checkbox"],[role="combobox"],' +
    '[role="textbox"],[role="button"],[role="link"]'));
  // --- P9-A4.5 F1：C0 candidate-budget 治理（通用，无站点特判）---
  const INTERACTIVE_SELECTOR = 'a[href],button,input,textarea,select,[role="button"],[role="link"],' +
    '[role="textbox"],[role="combobox"],[role="checkbox"]';
  const CONTAINER_TAGS = new Set(['LI', 'DIV', 'SPAN', 'UL', 'OL', 'SECTION', 'ARTICLE', 'NAV',
    'HEADER', 'FOOTER', 'ASIDE', 'MAIN']);
  // 语义优先级（通用 HTML5 语义，无站点特判）：
  // 表单交互（button/input/textarea/select 等）0 > 正文区链接（main/role=main 内）1
  // > 其他链接 2 > 导航区链接（nav/aside/header/footer 等）3 > 容器（listitem/row）4 > 其他 5
  const semanticRankOf = (element) => {
    if (element.matches('button,input,textarea,select,[role="button"],[role="textbox"],[role="combobox"],[role="checkbox"]')) return 0;
    if (element.matches('a[href],[role="link"]')) {
      if (element.closest('main,[role="main"]')) return 1;
      if (element.closest('nav,aside,header,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]')) return 3;
      return 2;
    }
    const role = roleOf(element);
    if (role === 'listitem' || role === 'row') return 4;
    return 5;
  };
  const raw = all.map((element) => {
    const input = element;
    const checkboxes = element.matches('input[type="checkbox"],[role="checkbox"]')
      ? [element] : Array.from(element.querySelectorAll('input[type="checkbox"],[role="checkbox"]'));
    const checkbox = checkboxes.length === 1 ? checkboxes[0] : undefined;
    const role = roleOf(element);
    const rawText = (element.textContent || '').replace(/\\s+/g, ' ').trim();
    const rawName = element.getAttribute('aria-label') || element.getAttribute('name') || undefined;
    const text = rawText || (role === 'checkbox' ? rawName || '' : '');
    const name = rawName ? rawName.slice(0, 300) : undefined;
    const sensitive = element.matches('input[type="password"],input[type="file"],input[type="hidden"]');
    const options = element.tagName === 'SELECT'
      ? Array.from(element.options).map((option) => option.text) : undefined;
    const item = { role, name, text: text.slice(0, 300),
      // href 为通用 DOM 属性：供语义目标重映射（A4）做辅助证据，不含业务语义。
      href: element instanceof HTMLAnchorElement ? element.getAttribute('href')?.slice(0, 300) : undefined,
      value: element.matches('input,textarea,select') && !sensitive ? input.value.slice(0, 300) : undefined,
      checked: checkbox ? checkbox.matches('input') ? checkbox.checked
        : ['true', 'false'].includes(checkbox.getAttribute('aria-checked') || '')
          ? checkbox.getAttribute('aria-checked') === 'true' : undefined : undefined,
      identity: generation + ':' + pathOf(element),
      ...(options !== undefined ? { options } : {}),
      classTokens: Array.from(element.classList).slice(0, 30),
      complete: text.length <= 300 && (rawName ? rawName.length : 0) <= 300 &&
        element.classList.length <= 30 && checkboxes.length <= 1 &&
        (!element.matches('input,textarea,select') || sensitive || input.value.length <= 300) };
    return { element, item };
  });
  // 去重：容器（li/div 等非交互标签）内含文本相同的已采集交互后代 → 壳层副本，抑制容器保留交互叶。
  const dedup = raw.filter(({ element, item }) => {
    if (element.matches(INTERACTIVE_SELECTOR)) return true; // 交互叶永远保留
    if (!CONTAINER_TAGS.has(element.tagName)) return true;   // 非容器保留
    const inner = element.querySelector(INTERACTIVE_SELECTOR);
    if (inner && inner !== element) {
      const innerText = (inner.textContent || '').replace(/\\s+/g, ' ').trim();
      if (innerText && (item.text || '') === innerText) return false; // 容器文本==交互叶文本 → 壳层重复
    }
    return true;
  });
  // 语义优先排序（Array.prototype.sort 在 ES2019+ 规范下为 stable，文档序为 tie-break）。
  const ranked = dedup.sort((a, b) => semanticRankOf(a.element) - semanticRankOf(b.element));
  // 同语义目标重复抑制：同一 a[href]（同 text+href）只保留文档序首个（A4 semantic remap
  // 需要 unique hit；重复候选反而制造 ambiguity）。非链接元素（checkbox/button/input 等）
  // 即使 text 相同也是不同候选，不去重。
  const seenTarget = new Set();
  const dedup2 = ranked.filter(({ element, item }) => {
    if (!(element instanceof HTMLAnchorElement && element.getAttribute('href'))) return true;
    const key = (item.text || '') + '|' + (item.href || '');
    if (seenTarget.has(key)) return false;
    seenTarget.add(key);
    return true;
  });
  // 最后截断。
  const items = dedup2.slice(0, 500).map((r) => r.item);
  return { source: 'dom', complete: dedup2.length <= 500 && items.every((item) => item.complete),
    candidateCount: dedup2.length, retainedCount: items.length, candidateBudget: 500,
    budgetSaturated: dedup2.length > 500, items };
})()`;
