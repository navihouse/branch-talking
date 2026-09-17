(function () {
  'use strict';

  const STORAGE_KEY = 'branch-chat-v1';

  // 纯常量系统提示：每一次请求都逐字节相同，
  // 从第 0 个 token 起构成一段可被 DeepSeek 上下文缓存复用的稳定前缀。
  const SYSTEM_PROMPT = [
    '你是一个帮助用户逐步拆解、拓展与深化话题的中文助手。你的回复会以卡片形式展示在树状对话界面中。',
    '',
    '## 对话形态',
    '- 用户可能在「子卡片」中要求你沿着上一张卡片继续深入，也可能在「平行卡片」中要求你围绕某段被选中的内容横向展开。',
    '- 你会在历史消息中看到此前卡片的提问与回答，请把它们当作已确立的上下文：延续结论、承接细节，不要重复已经说过的内容，不要复述用户的提问。',
    '- 若新要求与上文冲突，以用户最新的要求为准，并简要说明你的调整。',
    '',
    '## 输出格式',
    '- 使用 Markdown：标题用 ## 或 ###，并列内容用有序或无序列表，关键术语可加粗。',
    '- 代码块使用三个反引号包裹，并在开头标注语言，例如 js、python、bash。',
    '- 结构上先给结论或要点，再给必要的解释；避免空话、套话与无意义的重复。',
    '- 默认使用简体中文；用户使用其他语言或明确要求时，跟随用户。',
    '',
    '## 数学公式',
    '- 行内公式用 $ ... $ 包裹；独立成行的公式用 $$ ... $$ 包裹。',
    '- 公式必须是标准 LaTeX（KaTeX 可渲染）：分式用 \\frac，根号用 \\sqrt，求和用 \\sum，积分用 \\int，不要用图片或纯文本近似代替公式。',
    '- 变量、函数名与单位保持规范；必要时先定义符号再使用。',
    '',
    '## 内容质量',
    '- 准确优先：不确定的事实要明确说明不确定，不要编造数据、引用或链接。',
    '- 篇幅与问题复杂度匹配：简单问题简短回答，复杂问题分点展开。',
    '- 需要推导时给出关键步骤，而不是只给最终结果。',
  ].join('\n');

  const app = document.getElementById('app');
  const main = document.getElementById('main');
  const canvas = document.getElementById('canvas');
  const tree = document.getElementById('tree');
  const statusEl = document.getElementById('status');
  const toastEl = document.getElementById('toast');
  const composer = document.getElementById('composer');
  const promptInput = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const clearBtn = document.getElementById('clearBtn');
  const banner = document.getElementById('banner');
  const root = document.documentElement;

  const bgLayer = document.getElementById('bgLayer');
  const selBtn = document.getElementById('selBtn');
  const attachBtn = document.getElementById('attachBtn');
  const attachInput = document.getElementById('attachInput');
  const attachStrip = document.getElementById('attachStrip');
  const dropMask = document.getElementById('dropMask');
  const themeBtn = document.getElementById('themeBtn');
  const themePanel = document.getElementById('themePanel');
  const themeClose = document.getElementById('themeClose');
  const themeReset = document.getElementById('themeReset');
  const themeStatus = document.getElementById('themeStatus');
  const themeBgColor = document.getElementById('themeBgColor');
  const themeBgImage = document.getElementById('themeBgImage');
  const themeBgOpacity = document.getElementById('themeBgOpacity');
  const themeBgOpacityVal = document.getElementById('themeBgOpacityVal');
  const themeBgClear = document.getElementById('themeBgClear');
  const themeCardRoot = document.getElementById('themeCardRoot');
  const themeCardChild = document.getElementById('themeCardChild');
  const themeCardParallel = document.getElementById('themeCardParallel');
  const swatches = {
    background: document.getElementById('swBgColor'),
    cardRoot: document.getElementById('swCardRoot'),
    cardChild: document.getElementById('swCardChild'),
    cardParallel: document.getElementById('swCardParallel'),
  };

  let state = loadState();
  let streaming = 0;

  /* ---------------- persistence ---------------- */

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { nodes: {}, roots: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { nodes: {}, roots: [] };
      parsed.nodes = parsed.nodes || {};
      parsed.roots = parsed.roots || [];

      Object.values(parsed.nodes).forEach((n) => {
        n.children = n.children || [];
        n.parallels = n.parallels || [];
        n.images = n.images || [];
        n.docs = n.docs || [];
        if (!n.title) n.title = n.prompt || '';
        if (n.status === 'streaming') n.status = 'interrupted';
        const kept = [];
        n.children.forEach((cid) => {
          const c = parsed.nodes[cid];
          if (c && c.kind === 'parallel') {
            if (!n.parallels.includes(cid)) n.parallels.push(cid);
          } else {
            kept.push(cid);
          }
        });
        n.children = kept;
      });
      return parsed;
    } catch {
      return { nodes: {}, roots: [] };
    }
  }

  let quotaWarned = false;
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      if (!quotaWarned) {
        quotaWarned = true;
        toast('本地存储已满，新卡片可能无法保存（附件文档太大时会这样）');
      }
    }
  }

  /* ---------------- helpers ---------------- */

  function uid() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // 粗略估算 token 数（中文约 1 字 1 token，其余约 3.5 字符 1 token），仅用于安全上限
  function estTokens(text) {
    const s = String(text || '');
    let cjk = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0x2e80 && c <= 0x9fff) cjk++;
    }
    return cjk + Math.ceil((s.length - cjk) / 3.5);
  }

  function plain(text, max) {
    const t = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\$\$?/g, ' ')
      .replace(/\\[a-zA-Z]+/g, ' ')
      .replace(/[*_`#>~{}$\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  /* ---------------- markdown + latex ---------------- */

  function mathHtml(tex, display) {
    const src = String(tex).trim();
    if (window.katex && typeof window.katex.renderToString === 'function') {
      try {
        return window.katex.renderToString(src, {
          displayMode: !!display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
          output: 'htmlAndMathml',
        });
      } catch {
        /* fall through */
      }
    }
    const delim = display ? '$$' : '$';
    return '<code class="inline math-fallback">' + escapeHtml(delim + src + delim) + '</code>';
  }

  function renderMarkdown(src) {
    if (!src) return '';
    const store = [];
    const stash = (html) => {
      store.push(html);
      return '\u0000' + (store.length - 1) + '\u0000';
    };

    let text = String(src).replace(/\r\n/g, '\n');

    text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, code) =>
      stash('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>')
    );

    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(mathHtml(tex, true)));
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(mathHtml(tex, true)));
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(mathHtml(tex, false)));
    text = text.replace(/\$([^$\n]+)\$/g, (m, tex) => {
      if (/^\s|\s$/.test(tex)) return m;
      return stash(mathHtml(tex, false));
    });

    const inline = (t) =>
      t
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code class="inline">$1</code>');

    let html = '';
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        html += '<div class="gap"></div>';
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length, 4);
        html += `<div class="md-h md-h${level}">${inline(escapeHtml(heading[2]))}</div>`;
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        html += '<div class="md-li">• ' + inline(escapeHtml(bullet[1])) + '</div>';
        continue;
      }
      const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ordered) {
        html += '<div class="md-li">' + inline(escapeHtml(ordered[1])) + '</div>';
        continue;
      }
      html += '<div class="md-p">' + inline(escapeHtml(line)) + '</div>';
    }

    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)] || '');
  }

  /* ---------------- toast / status / banner ---------------- */

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showBanner(html, ok) {
    banner.innerHTML = html;
    banner.className = 'banner' + (ok ? ' ok' : '');
    banner.hidden = false;
  }

  function hideBanner() {
    banner.hidden = true;
    banner.innerHTML = '';
  }

  function busy(delta) {
    streaming = Math.max(0, streaming + delta);
    sendBtn.disabled = streaming > 0;
    setStatus(streaming > 0 ? '生成中…' : '', streaming > 0 ? 'busy' : '');
  }

  /* ---------------- rendering ---------------- */

  function toolBtn(act, label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool';
    b.dataset.act = act;
    b.title = title;
    b.textContent = label;
    return b;
  }

  function winBtn(act, label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wbtn wbtn-' + act;
    b.dataset.act = act;
    b.title = title;
    b.textContent = label;
    return b;
  }

  function cardEl(node, depth) {
    const card = document.createElement('article');
    card.className =
      'card kind-' +
      node.kind +
      (node.status === 'error' ? ' is-error' : '') +
      (node.collapsed ? ' collapsed' : '');
    card.dataset.id = node.id;
    card.dataset.depth = String(depth || 0);
    if (node.parentId) card.dataset.parent = node.parentId;

    const head = document.createElement('div');
    head.className = 'card-head';

    const role = document.createElement('span');
    role.className = 'role role-' + node.role;
    role.textContent = node.role === 'user' ? '你' : 'AI';
    head.appendChild(role);

    if (node.kind === 'parallel') {
      const tag = document.createElement('span');
      tag.className = 'kind-tag';
      tag.textContent = '~ 平行';
      head.appendChild(tag);
    } else if (node.kind === 'child') {
      const tag = document.createElement('span');
      tag.className = 'kind-tag child';
      tag.textContent = '+ 子卡片';
      head.appendChild(tag);
    }

    // 最小化后显示的标题（点击卡片可还原）
    const title = document.createElement('span');
    title.className = 'collapsed-title';
    title.textContent = plain(node.title || node.prompt || node.content, 72);
    head.appendChild(title);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(node.createdAt);
    head.appendChild(time);

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.appendChild(spacer);

    head.appendChild(toolBtn('child', '+', '创建子卡片，在下方继续推进这个话题'));
    head.appendChild(toolBtn('parallel', '~', '先在卡片中选中文字，再点此创建平行卡片'));

    const win = document.createElement('div');
    win.className = 'win-controls';
    win.appendChild(winBtn('minimize', '─', '最小化（点击卡片可还原）'));
    win.appendChild(winBtn('maximize', '▢', '最大化 / 还原'));
    win.appendChild(winBtn('close', '✕', '关闭并删除该卡片及其全部分支'));
    head.appendChild(win);

    card.appendChild(head);

    // 这条提问附带的资料（图片缩略图 / 文档名）
    const atts = (node.images || [])
      .map((im) => ({ name: im.name, thumb: im.thumb, icon: '🖼' }))
      .concat((node.docs || []).map((d) => ({ name: d.name, icon: '📄', sub: d.chars ? d.chars + ' 字' : '' })));
    if (atts.length) {
      const strip = document.createElement('div');
      strip.className = 'card-attach';
      atts.forEach((a) => {
        strip.appendChild(attachChipEl({ name: a.name, thumb: a.thumb, icon: a.icon, sub: a.sub }));
      });
      card.appendChild(strip);
    }

    if (node.sourceText) {
      const src = document.createElement('div');
      src.className = 'card-source';
      const shown = node.sourceText.length > 220 ? node.sourceText.slice(0, 220) + '…' : node.sourceText;
      src.innerHTML = '<span class="q-mark">“</span>' + escapeHtml(shown) + '<span class="q-mark">”</span>';
      card.appendChild(src);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = bodyHtml(node);
    card.appendChild(body);

    if (node.usage) card.appendChild(metaEl(node));

    const form = document.createElement('form');
    form.className = 'inline-composer';
    form.hidden = true;
    card.appendChild(form);

    return card;
  }

  function metaEl(node) {
    const usage = node.usage || {};
    const el = document.createElement('div');
    el.className = 'card-meta';
    const cached = usage.prompt_cache_hit_tokens ?? 0;
    const prompt = usage.prompt_tokens ?? '?';
    const completion = usage.completion_tokens ?? '?';
    const details = usage.completion_tokens_details || {};
    const reason = details.reasoning_tokens || 0;
    let text = `↑ 输入 ${prompt}（缓存命中 ${cached}） · ↓ 输出 ${completion}`;
    if (reason) text += `（其中思考 ${reason}）`;
    text += ` · 合计 ${usage.total_tokens ?? '?'}`;
    if (node.finish === 'length') text += ' · 已截断';
    el.textContent = text;
    el.title = `未命中缓存 ${usage.prompt_cache_miss_tokens ?? '?'} tokens；finish_reason=${node.finish || '-'}`;
    return el;
  }

  // 子树规模：下游卡片（子卡片 + 平行卡片，递归）总数。
  // 参考 d3.tree 的 separation 思路：分支越“重”，离主干越远。
  let subtreeSizes = new Map();

  function subtreeSize(node) {
    if (!node) return 0;
    const cached = subtreeSizes.get(node.id);
    if (cached !== undefined) return cached;
    let count = 0;
    (node.children || []).forEach((id) => {
      const c = state.nodes[id];
      if (c) count += 1 + subtreeSize(c);
    });
    (node.parallels || []).forEach((id) => {
      const p = state.nodes[id];
      if (p) count += 1 + subtreeSize(p);
    });
    subtreeSizes.set(node.id, count);
    return count;
  }

  const CHILD_GAP = 34;
  const CHILD_INDENT_STEP = 10;
  const CHILD_INDENT_MAX = 150;
  const SIDE_INDENT = 26;

  // 子卡片的横向间距 = 基础间距 + 与下游规模正相关的额外距离（有上限）
  function childIndent(node) {
    const extra = Math.min(CHILD_INDENT_MAX, subtreeSize(node) * CHILD_INDENT_STEP);
    return CHILD_GAP + extra;
  }

  // 结构：主卡片居中；+ 子卡片在主卡片【下方】；~ 平行卡片在主卡片【两侧】
  // side=true 表示当前位于侧栏（平行分支）内部，不再叠加额外偏移，避免列被撑宽
  function renderBranch(node, depth, side) {
    const d = depth || 0;
    const branch = document.createElement('div');
    branch.className = 'branch';

    const row = document.createElement('div');
    row.className = 'branch-row';

    const left = document.createElement('div');
    left.className = 'parallel-col left';
    const right = document.createElement('div');
    right.className = 'parallel-col right';

    (node.parallels || []).forEach((pid, i) => {
      const p = state.nodes[pid];
      if (!p) return;
      (i % 2 === 0 ? left : right).appendChild(renderBranch(p, d + 1, true));
    });

    const nodeCol = document.createElement('div');
    nodeCol.className = 'node-col';
    nodeCol.appendChild(cardEl(node, d));

    const kids = document.createElement('div');
    kids.className = 'children-wrap';
    (node.children || []).forEach((cid) => {
      const c = state.nodes[cid];
      if (!c) return;
      const el = renderBranch(c, d + 1, side);
      el.style.marginLeft = (side ? SIDE_INDENT : childIndent(c)) + 'px';
      kids.appendChild(el);
    });
    if (kids.children.length) nodeCol.appendChild(kids);

    row.appendChild(left);
    row.appendChild(nodeCol);
    row.appendChild(right);
    branch.appendChild(row);
    return branch;
  }

  function bodyHtml(node) {
    let html = '';

    if (node.reasoning && node.reasoning.trim()) {
      const details = (node.usage && node.usage.completion_tokens_details) || {};
      const rt = details.reasoning_tokens;
      html +=
        '<details class="reason-box"' +
        (node.status === 'streaming' ? ' open' : '') +
        '><summary>思考过程' +
        (rt ? '（' + rt + ' tokens）' : '') +
        '</summary><div class="reason-body">' +
        renderMarkdown(node.reasoning) +
        '</div></details>';
    }

    if (node.content) html += renderMarkdown(node.content);

    if (node.status === 'streaming') return html + '<span class="cursor"></span>';
    if (node.status === 'interrupted' && !node.content && !node.reasoning) {
      return '<span class="cursor"></span>';
    }

    if (node.finish === 'length') {
      html +=
        '<div class="warn">⚠ 输出达到上限被截断，正文可能不完整。可在 <code>.env</code> 调大 <code>DEEPSEEK_MAX_TOKENS</code> 后重启。</div>';
    }
    if (!node.content && node.reasoning && node.reasoning.trim()) {
      html +=
        '<div class="warn">模型只返回了思考内容、没有正文——通常是思考 token 占满了输出上限。服务默认已关闭思考模式（<code>DEEPSEEK_THINKING=disabled</code>），重启后即可正常。</div>';
    }
    return html;
  }

  function render() {
    app.classList.toggle('empty', state.roots.length === 0);
    tree.innerHTML = '';
    hideSelBtn();
    subtreeSizes = new Map();

    linksSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    linksSvg.setAttribute('id', 'links');
    linksSvg.setAttribute('class', 'links');
    linksSvg.setAttribute('aria-hidden', 'true');
    tree.appendChild(linksSvg);

    state.roots.forEach((id) => {
      const node = state.nodes[id];
      if (node) tree.appendChild(renderBranch(node, 0));
    });
    scheduleLinks();
  }

  function findCard(id) {
    return tree.querySelector('[data-id="' + id + '"]');
  }

  function updateCard(id) {
    const node = state.nodes[id];
    const card = findCard(id);
    if (!node || !card) return;

    const body = card.querySelector('.card-body');
    if (body) body.innerHTML = bodyHtml(node);

    let meta = card.querySelector('.card-meta');
    if (node.usage) {
      const fresh = metaEl(node);
      if (meta) meta.replaceWith(fresh);
      else card.insertBefore(fresh, card.querySelector('.inline-composer'));
    } else if (meta) {
      meta.remove();
    }
    scheduleLinks();
  }

  const pendingRender = new Set();
  let rafId = null;
  function scheduleCardRender(id) {
    pendingRender.add(id);
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      pendingRender.forEach((x) => updateCard(x));
      pendingRender.clear();
      if (followTarget) followCard(followTarget);
    });
  }

  /* ---------------- 卡片连线 ---------------- */

  let linksSvg = null;
  let linksRaf = null;

  function scheduleLinks() {
    if (linksRaf) return;
    linksRaf = requestAnimationFrame(() => {
      linksRaf = null;
      drawLinks();
    });
  }

  function anchorPoints(p, c) {
    const pcx = p.left + p.width / 2;
    const ccx = c.left + c.width / 2;
    if (c.top >= p.bottom - 4) {
      // 子卡片：父卡片底部 -> 子卡片顶部
      return { x1: pcx, y1: p.bottom, x2: ccx, y2: c.top, axis: 'v' };
    }
    const y1 = p.top + Math.min(30, p.height / 2);
    const y2 = c.top + Math.min(30, c.height / 2);
    if (c.left >= p.right - 4) {
      // 平行卡片在右侧：父卡片右边 -> 平行卡片左边
      return { x1: p.right, y1, x2: c.left, y2, axis: 'h' };
    }
    if (c.right <= p.left + 4) {
      // 平行卡片在左侧：父卡片左边 -> 平行卡片右边
      return { x1: p.left, y1, x2: c.right, y2, axis: 'h' };
    }
    return { x1: pcx, y1: p.bottom, x2: ccx, y2: c.top, axis: 'v' };
  }

  function pathFor(a) {
    const r = (n) => Math.round(n * 10) / 10;
    if (a.axis === 'v') {
      const dy = (a.y2 - a.y1) * 0.5;
      return `M ${r(a.x1)} ${r(a.y1)} C ${r(a.x1)} ${r(a.y1 + dy)}, ${r(a.x2)} ${r(a.y2 - dy)}, ${r(a.x2)} ${r(a.y2)}`;
    }
    // 平行分支：向上拱起的小弧，配合流动虚线形成波动感
    const dx = (a.x2 - a.x1) * 0.5;
    const arcY = Math.min(a.y1, a.y2) - 13;
    return `M ${r(a.x1)} ${r(a.y1)} C ${r(a.x1 + dx)} ${r(arcY)}, ${r(a.x2 - dx)} ${r(arcY)}, ${r(a.x2)} ${r(a.y2)}`;
  }

  function drawLinks() {
    if (!linksSvg || !linksSvg.isConnected) return;
    const treeRect = tree.getBoundingClientRect();
    const width = Math.max(1, Math.round(tree.clientWidth));
    const height = Math.max(1, Math.round(tree.scrollHeight));
    linksSvg.setAttribute('width', width);
    linksSvg.setAttribute('height', height);
    linksSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const rel = (rect) => ({
      left: rect.left - treeRect.left,
      top: rect.top - treeRect.top,
      right: rect.right - treeRect.left,
      bottom: rect.bottom - treeRect.top,
      width: rect.width,
      height: rect.height,
    });

    let out = '';
    tree.querySelectorAll('.card[data-parent]').forEach((el) => {
      const parentEl = tree.querySelector('.card[data-id="' + el.dataset.parent + '"]');
      if (!parentEl) return;
      if (el.classList.contains('maximized') || parentEl.classList.contains('maximized')) return;
      const d = pathFor(anchorPoints(rel(parentEl.getBoundingClientRect()), rel(el.getBoundingClientRect())));
      out += '<path class="link-base" d="' + d + '"></path>';
      out += '<path class="link-flow" d="' + d + '"></path>';
    });
    linksSvg.innerHTML = out;
  }

  /* ---------------- composer (inline) ---------------- */

  function closeComposer(form) {
    if (!form) return;
    form.hidden = true;
    form.innerHTML = '';
    delete form.dataset.mode;
    delete form.dataset.source;
    delete form.dataset.parentId;
  }

  function closeAllComposers() {
    tree.querySelectorAll('.inline-composer').forEach(closeComposer);
  }

  function expandCard(card) {
    const node = state.nodes[card.dataset.id];
    if (!card.classList.contains('collapsed')) return;
    card.classList.remove('collapsed');
    if (node) node.collapsed = false;
    saveState();
    scheduleLinks();
  }

  function openComposer(card, mode, sourceText) {
    const form = card.querySelector('.inline-composer');
    if (!form.hidden) {
      closeComposer(form);
      return;
    }
    closeAllComposers();
    expandCard(card);
    hideSelBtn();
    clearSelection();

    form.dataset.mode = mode;
    form.dataset.source = sourceText || '';
    form.dataset.parentId = card.dataset.id;

    const placeholder =
      mode === 'parallel'
        ? '针对上面选中的内容，输入你想拓展的提示词…'
        : '输入提示词，继续推进这个子话题…';

    const quoteHtml = sourceText
      ? '<div class="quoted">选中内容：' +
        escapeHtml(sourceText.length > 160 ? sourceText.slice(0, 160) + '…' : sourceText) +
        '</div>'
      : '';

    form.innerHTML =
      quoteHtml +
      '<textarea class="comp-input" rows="2" placeholder="' +
      escapeHtml(placeholder) +
      '"></textarea>' +
      '<div class="comp-actions">' +
      '<span class="comp-hint">Enter 生成 · Shift+Enter 换行</span>' +
      '<button type="button" class="btn ghost small" data-act="cancel">取消</button>' +
      '<button type="submit" class="btn primary small">生成</button>' +
      '</div>';

    form.hidden = false;
    const input = form.querySelector('.comp-input');
    input.focus();
  }

  /* ---------------- card window controls ---------------- */

  function minimizeCard(card) {
    const node = state.nodes[card.dataset.id];
    const collapsed = card.classList.toggle('collapsed');
    if (node) node.collapsed = collapsed;
    if (collapsed) closeComposer(card.querySelector('.inline-composer'));
    saveState();
    scheduleLinks();
  }

  function restoreAllMaximized() {
    tree.querySelectorAll('.card.maximized').forEach((c) => c.classList.remove('maximized'));
    scheduleLinks();
  }

  function collectIds(id, out) {
    const n = state.nodes[id];
    if (!n) return;
    out.push(id);
    (n.children || []).forEach((c) => collectIds(c, out));
    (n.parallels || []).forEach((c) => collectIds(c, out));
  }

  function deleteNode(id) {
    const n = state.nodes[id];
    if (!n) return;
    const ids = [];
    collectIds(id, ids);

    const detach = (arr) => {
      if (!arr) return;
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
    };
    const parent = n.parentId ? state.nodes[n.parentId] : null;
    if (parent) {
      detach(parent.children);
      detach(parent.parallels);
    } else {
      detach(state.roots);
    }

    ids.forEach((x) => delete state.nodes[x]);
    saveState();
    render();
  }

  function requestDelete(card) {
    const node = state.nodes[card.dataset.id];
    if (!node) return;
    const ids = [];
    collectIds(node.id, ids);
    const extra = ids.length - 1;
    const msg = extra > 0 ? `删除该卡片及其 ${extra} 个下游卡片？` : '删除这张卡片？';
    if (!window.confirm(msg)) return;
    deleteNode(node.id);
    toast('已删除');
  }

  /* ---------------- selection ---------------- */

  function selectionInCard(card) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const range = sel.getRangeAt(0);
    const body = card.querySelector('.card-body');
    if (body && body.contains(range.commonAncestorContainer)) return text;
    return '';
  }

  // 选区浮动按钮：在选中文字的上方浮出 “~”，不覆盖选中的内容
  let selTarget = null;
  let selText = '';
  let selRaf = null;

  function clearSelection() {
    const sel = window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  }

  function getSelectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.isConnected) return null;
    const body = el.closest ? el.closest('.card-body') : null;
    if (!body || !body.isConnected) return null;
    const card = body.closest('.card');
    // 卡片被重新渲染后旧选区会指向游离节点，这里必须过滤掉
    if (!card || !card.isConnected) return null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { card, text, rect };
  }

  function hideSelBtn() {
    selBtn.hidden = true;
  }

  function updateSelBtn() {
    const info = getSelectionInfo();
    if (!info) {
      hideSelBtn();
      return;
    }
    selTarget = info.card;
    selText = info.text;

    const rect = info.rect;
    const vw = window.innerWidth;
    const centerX = Math.min(Math.max(rect.left + rect.width / 2, 28), vw - 28);
    const showAbove = rect.top > 56;

    selBtn.style.left = centerX + 'px';
    if (showAbove) {
      selBtn.style.top = rect.top - 9 + 'px';
      selBtn.style.transform = 'translate(-50%, -100%)';
    } else {
      selBtn.style.top = rect.bottom + 9 + 'px';
      selBtn.style.transform = 'translate(-50%, 0)';
    }
    selBtn.hidden = false;
  }

  function scheduleSelUpdate() {
    if (selRaf) return;
    selRaf = requestAnimationFrame(() => {
      selRaf = null;
      updateSelBtn();
    });
  }

  function initSelectionButton() {
    document.addEventListener('selectionchange', scheduleSelUpdate);
    window.addEventListener('resize', hideSelBtn);
    window.addEventListener('scroll', hideSelBtn, true);

    // 保持选区，避免点击按钮时选中内容被清空
    selBtn.addEventListener('mousedown', (e) => e.preventDefault());
    selBtn.addEventListener('click', () => {
      if (!selTarget) return;
      const card = selTarget;
      const text = selText;
      hideSelBtn();
      clearSelection();
      openComposer(card, 'parallel', text);
    });

    // 点到别处（按钮以外）立即收起浮动按钮
    document.addEventListener(
      'mousedown',
      (e) => {
        if (!selBtn.hidden && !selBtn.contains(e.target)) hideSelBtn();
      },
      true
    );
  }

  /* ---------------- 附件（文档 / 图片） ---------------- */

  const MAX_ATTACH = 6;
  const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
  const MAX_DOC_CHARS = 20000;
  const IMAGE_MAX_DIM = 1600;

  const TEXT_EXT = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini', 'conf', 'env',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs',
    'rb', 'php', 'sql', 'sh', 'bash', 'ps1', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'tex',
  ]);

  let pendingAttachments = [];
  // 图片只在「当次请求」真正发送；节点里只存缩略图，避免 localStorage / 上下文被撑爆
  const sessionImages = new Map();

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function fileToText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('读取失败'));
      r.readAsText(file);
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('读取失败'));
      r.readAsDataURL(file);
    });
  }

  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片无法解码（文件可能已损坏）'));
      img.src = src;
    });
  }

  // 图片统一缩放到长边 <= 1600，既省 token 也避免请求体过大
  async function prepareImage(file) {
    const raw = await fileToDataUrl(file);
    // 浏览器解不出来 = 图片本身无效，直接报错，别把坏图发给模型（服务端会 400）
    const img = await loadImageEl(raw);
    const w0 = img.naturalWidth || 0;
    const h0 = img.naturalHeight || 0;
    const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(w0 || 1, h0 || 1));
    const draw = (tw, th) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, tw);
      c.height = Math.max(1, th);
      c.getContext('2d').drawImage(img, 0, 0, Math.max(1, tw), Math.max(1, th));
      return c;
    };
    let full = raw;
    if (scale < 1 || file.size > 1.2 * 1024 * 1024) {
      full = draw(Math.round(w0 * scale), Math.round(h0 * scale)).toDataURL('image/jpeg', 0.86);
    }
    const tScale = Math.min(1, 160 / Math.max(w0 || 1, h0 || 1));
    let thumb = raw;
    try {
      thumb = draw(Math.round(w0 * tScale), Math.round(h0 * tScale)).toDataURL('image/jpeg', 0.7);
    } catch {
      /* 保底用原图 */
    }
    return { full, thumb, width: w0, height: h0 };
  }

  // ---- DOCX：本质是 ZIP，取出 word/document.xml ----
  function findZipEntry(buf, target) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    const floor = Math.max(0, buf.length - 66000);
    for (let i = buf.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
      if (off + 46 > buf.length || dv.getUint32(off, true) !== 0x02014b50) return null;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
      if (name === target) {
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        return { method, data: buf.subarray(start, start + compSize) };
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持解压，请使用较新的 Chrome / Edge');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function xmlToPlainText(xml) {
    return xml
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function extractDocx(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const entry = findZipEntry(buf, 'word/document.xml');
    if (!entry) throw new Error('不是有效的 .docx（未找到 document.xml）');
    const bytes = entry.method === 0 ? entry.data : await inflateRaw(entry.data);
    return xmlToPlainText(new TextDecoder('utf-8').decode(bytes));
  }

  // ---- PDF：使用本地化的 pdf.js 抽取文字 ----
  async function extractPdf(file, onProgress) {
    const lib = window.pdfjsLib;
    if (!lib) throw new Error('PDF 解析库还没加载好，请稍后重试');
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({ data, isEvalSupported: false, useWorkerFetch: false }).promise;
    const pages = Math.min(doc.numPages, 40);
    const parts = [];
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const line = tc.items.map((it) => it.str || '').join(' ').replace(/\s+/g, ' ').trim();
      if (line) parts.push(line);
      if (onProgress) onProgress(p, pages);
    }
    try {
      doc.destroy();
    } catch {
      /* ignore */
    }
    return parts.join('\n\n');
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (pendingAttachments.length >= MAX_ATTACH) {
        toast(`最多同时添加 ${MAX_ATTACH} 个附件`);
        break;
      }
      if (file.size > MAX_ATTACH_BYTES) {
        toast(`${file.name} 超过 20MB，已跳过`);
        continue;
      }

      const ext = extOf(file.name);
      const isImage =
        /^image\//.test(file.type) && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext || file.type.split('/')[1]);

      const att = {
        id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: file.name,
        size: file.size,
        kind: '',
        status: 'loading',
        text: '',
        full: '',
        thumb: '',
        note: '',
      };
      pendingAttachments.push(att);
      renderAttachments();

      try {
        if (isImage) {
          att.kind = 'image';
          if (file.type === 'image/gif') {
            att.full = await fileToDataUrl(file);
            att.thumb = att.full;
          } else {
            const prep = await prepareImage(file);
            att.full = prep.full;
            att.thumb = prep.thumb;
            att.note = prep.width ? `${prep.width}×${prep.height}` : '';
          }
          att.status = 'ready';
        } else if (ext === 'pdf') {
          att.kind = 'doc';
          const text = await extractPdf(file, (p, total) => {
            att.note = `解析中 ${p}/${total}`;
            renderAttachments();
          });
          att.text = text.slice(0, MAX_DOC_CHARS);
          att.note = `${att.text.length} 字` + (text.length > MAX_DOC_CHARS ? '（已截断）' : '');
          att.status = att.text.trim() ? 'ready' : 'error';
          if (att.status === 'error') att.note = '没有抽取到文字（可能是扫描件）';
        } else if (ext === 'docx') {
          att.kind = 'doc';
          const text = await extractDocx(file);
          att.text = text.slice(0, MAX_DOC_CHARS);
          att.note = `${att.text.length} 字` + (text.length > MAX_DOC_CHARS ? '（已截断）' : '');
          att.status = att.text.trim() ? 'ready' : 'error';
          if (att.status === 'error') att.note = '文档里没有文字';
        } else if (TEXT_EXT.has(ext) || /^text\//.test(file.type) || file.type === 'application/json') {
          att.kind = 'doc';
          const text = await fileToText(file);
          att.text = text.slice(0, MAX_DOC_CHARS);
          att.note = `${att.text.length} 字` + (text.length > MAX_DOC_CHARS ? '（已截断）' : '');
          att.status = 'ready';
        } else {
          att.status = 'error';
          att.note = '不支持的格式';
          toast(`${file.name}：暂不支持该格式（支持图片 / PDF / DOCX / 文本类）`);
        }
      } catch (err) {
        att.status = 'error';
        att.note = (err && err.message) || '解析失败';
        toast(`${file.name} 解析失败：${att.note}`);
      }
      renderAttachments();
    }
  }

  function attachChipEl(opts) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (opts.status ? ' ' + opts.status : '');
    if (opts.thumb) {
      const img = document.createElement('img');
      img.className = 'attach-thumb';
      img.src = opts.thumb;
      img.alt = opts.name || '';
      chip.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.className = 'attach-icon';
      ic.textContent = opts.icon || '📄';
      chip.appendChild(ic);
    }
    const meta = document.createElement('span');
    meta.className = 'attach-meta';
    const nm = document.createElement('span');
    nm.className = 'attach-name';
    nm.textContent = opts.name || '';
    const sub = document.createElement('span');
    sub.className = 'attach-sub';
    sub.textContent = opts.sub || '';
    meta.appendChild(nm);
    meta.appendChild(sub);
    chip.appendChild(meta);
    if (opts.removable) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'attach-x';
      x.textContent = '✕';
      x.title = '移除';
      x.dataset.removeAtt = opts.id;
      chip.appendChild(x);
    }
    return chip;
  }

  function renderAttachments() {
    attachStrip.innerHTML = '';
    if (!pendingAttachments.length) {
      attachStrip.hidden = true;
      return;
    }
    attachStrip.hidden = false;
    pendingAttachments.forEach((att) => {
      const icon = att.status === 'loading' ? '…' : att.status === 'error' ? '⚠' : att.kind === 'image' ? '🖼' : '📄';
      attachStrip.appendChild(
        attachChipEl({
          id: att.id,
          name: att.name,
          thumb: att.kind === 'image' ? att.thumb : '',
          icon,
          sub: att.note || fmtSize(att.size),
          status: att.status === 'loading' ? 'loading' : att.status === 'error' ? 'error' : '',
          removable: true,
        })
      );
    });
  }

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachments();
  }

  function initAttachments() {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
      addFiles(attachInput.files);
      attachInput.value = '';
    });
    attachStrip.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-att]');
      if (!btn) return;
      pendingAttachments = pendingAttachments.filter((a) => a.id !== btn.dataset.removeAtt);
      renderAttachments();
    });

    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth += 1;
      dropMask.hidden = false;
      e.preventDefault();
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      dragDepth -= 1;
      if (dragDepth <= 0) {
        dragDepth = 0;
        dropMask.hidden = true;
      }
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dropMask.hidden = true;
      addFiles(e.dataTransfer.files);
    });

    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.files;
      if (!items || !items.length) return;
      e.preventDefault();
      addFiles(items);
    });
  }

  /* ---------------- generation ---------------- */

  // 安全上限：仅在历史超预算时从最老整轮丢弃（会牺牲一次缓存命中）
  const HISTORY_TOKEN_BUDGET = 48000;

  // 单一来源：发送请求与回放祖先都调用它，
  // 保证同一条 user 消息逐字节可复现，缓存前缀才不会分叉。
  function composeUserMessage(node) {
    if (node.kind === 'parallel' && node.sourceText) {
      return (
        '请围绕主卡片中被选中的这段内容，横向拓展出一个新的方向：\n\n»» ' +
        node.sourceText +
        ' ««\n\n我的要求：' +
        node.prompt
      );
    }
    return node.prompt || '';
  }

  // 祖先卡片上的图片只留一句说明，不重发 base64（否则上下文会被瞬间撑爆）
  function imageNote(node) {
    const imgs = node.images || [];
    if (!imgs.length) return '';
    return '\n\n（本卡片附带图片：' + imgs.map((i) => i.name).join('、') + '）';
  }

  // 当前这条请求：带图片时用多模态 content 数组
  function currentUserContent(node) {
    const text = composeUserMessage(node);
    const imgs = sessionImages.get(node.id) || [];
    if (!imgs.length) return text;
    return [
      { type: 'text', text: text || '请分析这些图片。' },
      ...imgs.map((url) => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
    ];
  }

  function buildMessages(node) {
    const chain = [];
    let parent = node.parentId ? state.nodes[node.parentId] : null;
    while (parent) {
      chain.unshift(parent);
      parent = parent.parentId ? state.nodes[parent.parentId] : null;
    }

    // 逐字节稳定的历史：每张祖先卡片 = user(提问) + assistant(回复原文)
    // 直接父卡片的回复也在这里，从而能命中父卡片请求留下的缓存单元。
    const turns = [];
    chain.forEach((a) => {
      const ask = composeUserMessage(a);
      const note = imageNote(a);
      if (ask || note) turns.push({ role: 'user', content: (ask || '') + note });
      if (a.content) turns.push({ role: 'assistant', content: a.content });
    });

    let used = estTokens(SYSTEM_PROMPT);
    const kept = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const cost = estTokens(turns[i].content);
      if (kept.length && used + cost > HISTORY_TOKEN_BUDGET) break;
      used += cost;
      kept.unshift(turns[i]);
    }

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...kept];

    // 动态内容全部放在最后一条，避免破坏可缓存的稳定前缀
    messages.push({ role: 'user', content: currentUserContent(node) });

    return messages;
  }

  async function streamSSE(res, handlers) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          if (json.error) throw new Error(json.error);
          if (json.usage && handlers.onUsage) handlers.onUsage(json.usage);
          const choice = json.choices && json.choices[0];
          if (choice && choice.finish_reason && handlers.onFinish) handlers.onFinish(choice.finish_reason);
          const delta = choice && choice.delta;
          if (delta) {
            if (delta.reasoning_content && handlers.onReasoning) handlers.onReasoning(delta.reasoning_content);
            if (delta.content) handlers.onDelta(delta.content);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }

  /* ---------------- 无限画布视角 ---------------- */

  let panX = 0;
  let panY = 0;
  let userPannedAt = 0;
  let followTarget = null;
  let dragState = null;

  function applyPan() {
    canvas.style.transform = `translate3d(${panX}px, ${panY}px, 0)`;
  }

  function userScrolledRecently() {
    return Date.now() - userPannedAt < 2500;
  }

  // 卡片相对画布原点的坐标（与平移量无关）
  function localRect(el) {
    const cr = canvas.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      left: r.left - cr.left,
      top: r.top - cr.top,
      right: r.right - cr.left,
      bottom: r.bottom - cr.top,
      width: r.width,
      height: r.height,
    };
  }

  // 把所有卡片围成的区域居中到视口（进入页面时使用）
  function centerView() {
    const cards = tree.querySelectorAll('.card');
    if (!cards.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    cards.forEach((c) => {
      const r = localRect(c);
      if (!r.width && !r.height) return;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    });
    if (!isFinite(minX)) return;

    const vr = main.getBoundingClientRect();
    panX = vr.width / 2 - (minX + maxX) / 2;
    panY = vr.height / 2 - (minY + maxY) / 2;
    applyPan();
  }

  // 保证某张卡片出现在视口内（最小位移，不改变缩放）
  function ensureVisible(card) {
    if (!card) return;
    const cr = card.getBoundingClientRect();
    const vr = main.getBoundingClientRect();
    const m = 90;
    let dx = 0;
    let dy = 0;
    if (cr.right > vr.right - m) dx = vr.right - m - cr.right;
    if (cr.left + dx < vr.left + m) dx = vr.left + m - cr.left;
    if (cr.bottom > vr.bottom - m) dy = vr.bottom - m - cr.bottom;
    if (cr.top + dy < vr.top + m) dy = vr.top + m - cr.top;
    if (dx || dy) {
      panX += dx;
      panY += dy;
      applyPan();
    }
  }

  // 流式输出时让卡片底部保持在视口内
  function followCard(card) {
    if (!card || userScrolledRecently()) return;
    const cr = card.getBoundingClientRect();
    const vr = main.getBoundingClientRect();
    const margin = 90;
    let dy = 0;
    if (cr.bottom > vr.bottom - margin) dy = -(cr.bottom - (vr.bottom - margin));
    else if (cr.top < vr.top + margin) dy = vr.top + margin - cr.top;
    if (dy) {
      panY += dy;
      applyPan();
    }
  }

  function initPanning() {
    main.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.card, button, textarea, input, a, .composer, .hero')) return;
      dragState = { x: e.clientX, y: e.clientY };
      userPannedAt = Date.now();
      main.classList.add('panning');
      hideSelBtn();
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      panX += e.clientX - dragState.x;
      panY += e.clientY - dragState.y;
      dragState.x = e.clientX;
      dragState.y = e.clientY;
      applyPan();
      userPannedAt = Date.now();
    });

    window.addEventListener('mouseup', () => {
      if (!dragState) return;
      dragState = null;
      main.classList.remove('panning');
    });

    // 滚轮也用于平移（纵向为主，Shift 或横向滚轮走横向）
    main.addEventListener(
      'wheel',
      (e) => {
        // Shift+滚轮时，浏览器只在「可横向滚动」的元素上做轴交换；
        // 这里 #main 是 overflow:hidden 的无限画布，必须自己把纵向增量当横向用。
        const rawX = e.deltaX || 0;
        const rawY = e.deltaY || 0;
        const useShiftAsX = e.shiftKey && !rawX;
        const dx = useShiftAsX ? rawY : rawX;
        const dy = useShiftAsX ? 0 : rawY;
        panX -= dx;
        panY -= dy;
        applyPan();
        userPannedAt = Date.now();
        hideSelBtn();
      },
      { passive: true }
    );

    window.addEventListener('resize', () => {
      applyPan();
      scheduleLinks();
    });
  }

  async function generate(opts) {
    const id = uid();
    const docs = (opts.docs || []).filter((d) => d.status === 'ready' && d.text);
    const images = (opts.images || []).filter((im) => im.status === 'ready' && im.full);

    // 文档正文直接嵌进提示词：对任何模型都可用，且能随历史自然回放、利于缓存
    const docBlock = docs.map((d) => `【附件：${d.name}】\n"""\n${d.text}\n"""`).join('\n\n');
    const fullPrompt = docBlock ? docBlock + '\n\n' + opts.prompt : opts.prompt;

    const node = {
      id,
      parentId: opts.parentId || null,
      kind: opts.kind,
      role: 'assistant',
      content: '',
      reasoning: '',
      finish: null,
      title: opts.prompt,
      prompt: fullPrompt,
      sourceText: opts.sourceText || '',
      docs: docs.map((d) => ({ name: d.name, chars: d.text.length })),
      images: images.map((im) => ({ name: im.name, thumb: im.thumb })),
      createdAt: Date.now(),
      status: 'streaming',
      collapsed: false,
      usage: null,
      children: [],
      parallels: [],
    };
    if (images.length) sessionImages.set(id, images.map((im) => im.full));

    state.nodes[id] = node;
    const parent = node.parentId ? state.nodes[node.parentId] : null;
    if (parent) {
      if (node.kind === 'parallel') parent.parallels.push(id);
      else parent.children.push(id);
    } else {
      state.roots.push(id);
    }

    // 记录父卡片当前屏幕位置：新增平行卡片会让布局横向扩张，
    // 渲染后按位移反向补偿，父卡片视觉上不会跳动、也不会压到别的卡片。
    const anchorEl = parent ? findCard(parent.id) : null;
    const anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : null;

    saveState();
    render();

    if (anchorRect && parent) {
      const after = findCard(parent.id);
      if (after) {
        const r1 = after.getBoundingClientRect();
        panX += anchorRect.left - r1.left;
        panY += anchorRect.top - r1.top;
        applyPan();
      }
    }

    const card = findCard(id);
    if (!node.parentId && state.roots.length === 1) {
      centerView();
    } else {
      ensureVisible(card);
    }

    const body = card ? card.querySelector('.card-body') : null;
    const tools = card ? card.querySelectorAll('.tool') : [];
    tools.forEach((b) => (b.disabled = true));

    busy(1);
    followTarget = card;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    try {
      let res;
      try {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: buildMessages(node) }),
          signal: controller.signal,
        });
      } catch (netErr) {
        if (location.protocol === 'file:') {
          throw new Error(
            '页面是以本地文件方式打开的，无法连接后端。请先运行 node server.mjs，再访问 http://localhost:3000'
          );
        }
        if (netErr && netErr.name === 'AbortError') {
          throw new Error('请求超时（120 秒无响应），请检查网络后重试');
        }
        throw new Error(
          '无法连接后端服务：' +
            ((netErr && netErr.message) || netErr) +
            '。请确认 node server.mjs 正在运行，并通过 http://localhost:3000 访问。'
        );
      }

      if (!res.ok) {
        let message = '请求失败（HTTP ' + res.status + '）';
        try {
          const json = await res.json();
          if (json && json.error) message = json.error;
        } catch {
          /* ignore */
        }
        if (res.status === 401) message += '（API Key 无效或余额不足）';
        if (res.status === 429) message += '（触发限流，请稍后重试）';
        throw new Error(message);
      }

      await streamSSE(res, {
        onDelta: (piece) => {
          if (!state.nodes[id]) {
            controller.abort();
            return;
          }
          node.content += piece;
          scheduleCardRender(id);
        },
        onReasoning: (piece) => {
          if (!state.nodes[id]) return;
          node.reasoning += piece;
          scheduleCardRender(id);
        },
        onUsage: (usage) => {
          node.usage = usage;
        },
        onFinish: (finish) => {
          node.finish = finish;
        },
      });

      if (!node.content.trim() && !node.reasoning.trim()) node.content = '（模型没有返回内容）';
      node.status = 'done';
    } catch (err) {
      node.status = 'error';
      if (card) {
        card.classList.add('is-error');
        if (body) {
          body.innerHTML =
            renderMarkdown(node.content) + '<div class="err">⚠ ' + escapeHtml(err.message) + '</div>';
        }
      }
      setStatus('出错了', 'err');
      toast(err.message);
    } finally {
      clearTimeout(timer);
      tools.forEach((b) => (b.disabled = false));
      busy(-1);
      updateCard(id);
      saveState();
      if (card === followTarget) followTarget = null;
    }
  }

  /* ---------------- events ---------------- */

  tree.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tool') || e.target.closest('.wbtn')) e.preventDefault();
  });

  tree.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool, .wbtn');
    if (btn) {
      const card = btn.closest('.card');
      if (!card) return;
      const act = btn.dataset.act;
      if (act === 'child') {
        openComposer(card, 'child', '');
      } else if (act === 'parallel') {
        const text = selectionInCard(card);
        if (!text) {
          toast('请先在该卡片中选中要拓展的文字，再点 ~');
          return;
        }
        openComposer(card, 'parallel', text);
      } else if (act === 'minimize') {
        minimizeCard(card);
      } else if (act === 'maximize') {
        const on = card.classList.toggle('maximized');
        if (on) toast('已最大化，按 Esc 还原');
        scheduleLinks();
      } else if (act === 'close') {
        requestDelete(card);
      }
      return;
    }

    const cancel = e.target.closest('[data-act="cancel"]');
    if (cancel) {
      closeComposer(cancel.closest('.inline-composer'));
      return;
    }

    // 点击已最小化的卡片 → 还原到最小化之前的尺寸
    const collapsed = e.target.closest('.card.collapsed');
    if (collapsed) expandCard(collapsed);
  });

  tree.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.classList || !form.classList.contains('inline-composer')) return;
    e.preventDefault();
    const input = form.querySelector('.comp-input');
    const value = input ? input.value.trim() : '';
    if (!value) {
      if (input) input.focus();
      return;
    }
    const opts = {
      parentId: form.dataset.parentId,
      kind: form.dataset.mode,
      prompt: value,
      sourceText: form.dataset.source || '',
    };
    closeComposer(form);
    hideSelBtn();
    clearSelection();
    generate(opts);
  });

  tree.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const input = e.target.closest && e.target.closest('.comp-input');
    if (!input) return;
    e.preventDefault();
    const form = input.closest('form');
    if (form) form.requestSubmit();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      restoreAllMaximized();
      themePanel.hidden = true;
    }
  });

  window.addEventListener('resize', scheduleLinks);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleLinks).catch(() => {});
  }

  function autoResize() {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + 'px';
  }

  promptInput.addEventListener('input', autoResize);

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = promptInput.value.trim();
    const ready = pendingAttachments.filter((a) => a.status === 'ready');
    if (!value && !ready.length) return;
    promptInput.value = '';
    autoResize();
    generate({
      parentId: null,
      kind: 'root',
      prompt: value || '请阅读我附带的资料并概括要点。',
      sourceText: '',
      docs: ready.filter((a) => a.kind === 'doc'),
      images: ready.filter((a) => a.kind === 'image'),
    });
    clearAttachments();
  });

  clearBtn.addEventListener('click', () => {
    if (state.roots.length === 0) return;
    if (!window.confirm('确定清空所有卡片？此操作不可撤销。')) return;
    state = { nodes: {}, roots: [] };
    saveState();
    render();
    setStatus('');
    toast('已清空');
  });

  window.addEventListener('beforeunload', () => {
    Object.values(state.nodes).forEach((n) => {
      if (n.status === 'streaming') n.status = 'interrupted';
    });
    saveState();
  });

  /* ---------------- 主题 ---------------- */

  const THEME_CACHE_KEY = 'branch-chat-theme-v1';
  const THEME_DEFAULTS = {
    background: { color: '#0B0C0E', image: '', imageOpacity: 0.35 },
    cardRoot: '#111317',
    cardChild: '#111317',
    cardParallel: '#111317',
  };

  let theme = readThemeCache() || cloneTheme(THEME_DEFAULTS);
  let pendingImageData = null;
  let themeSaveTimer = null;

  function cloneTheme(t) {
    return JSON.parse(JSON.stringify(t));
  }

  function normalizeHex(value, fallback) {
    if (typeof value !== 'string') return fallback;
    let s = value.trim();
    if (!s.startsWith('#')) s = '#' + s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      s = '#' + s.slice(1).split('').map((c) => c + c).join('');
    }
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : fallback;
  }

  // 只接受两种图片来源：本地选择后的 data URL，或服务端落盘的主题图片路径。
  // 避免任何字符串被拼进 CSS url() 造成样式注入。
  function safeImageUrl(value) {
    if (typeof value !== 'string') return '';
    if (/^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/i.test(value)) return value;
    if (/^\/theme-bg\.(png|jpe?g|gif|webp|bmp)$/i.test(value)) return value;
    return '';
  }

  function sanitizeThemeClient(input) {
    const t = input && typeof input === 'object' ? input : {};
    const bg = t.background && typeof t.background === 'object' ? t.background : {};
    const op = Number(bg.imageOpacity);
    return {
      background: {
        color: normalizeHex(bg.color, THEME_DEFAULTS.background.color),
        image: safeImageUrl(bg.image),
        imageOpacity: Number.isFinite(op)
          ? Math.min(1, Math.max(0, op))
          : THEME_DEFAULTS.background.imageOpacity,
      },
      cardRoot: normalizeHex(t.cardRoot, THEME_DEFAULTS.cardRoot),
      cardChild: normalizeHex(t.cardChild, THEME_DEFAULTS.cardChild),
      cardParallel: normalizeHex(t.cardParallel, THEME_DEFAULTS.cardParallel),
    };
  }

  function readThemeCache() {
    try {
      const raw = localStorage.getItem(THEME_CACHE_KEY);
      return raw ? sanitizeThemeClient(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function writeThemeCache(t) {
    try {
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(t));
    } catch {
      /* 忽略 */
    }
  }

  // 依据底色亮度自动挑选可读的前景/弱化文字色
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function fgFor(hex) {
    return luminance(hex) > 0.45
      ? { fg: '#14171C', muted: '#525A64', muted2: '#767E88' }
      : { fg: '#E7E9EE', muted: '#8B909A', muted2: '#626873' };
  }

  function applyCardVars(prefix, hex) {
    const f = fgFor(hex);
    root.style.setProperty('--bg-' + prefix, hex);
    root.style.setProperty('--fg-' + prefix, f.fg);
    root.style.setProperty('--fgm-' + prefix, f.muted);
    root.style.setProperty('--fgm2-' + prefix, f.muted2);
  }

  function applyTheme(t) {
    root.style.setProperty('--bg', t.background.color);
    applyCardVars('root', t.cardRoot);
    applyCardVars('child', t.cardChild);
    applyCardVars('parallel', t.cardParallel);

    const img = safeImageUrl(pendingImageData) || t.background.image;
    if (img) {
      bgLayer.style.backgroundImage = 'url(' + JSON.stringify(img) + ')';
      bgLayer.style.opacity = String(t.background.imageOpacity);
      bgLayer.hidden = false;
    } else {
      bgLayer.style.backgroundImage = '';
      bgLayer.hidden = true;
    }
  }

  function setSwatch(el, hex) {
    if (el) el.style.background = hex || 'transparent';
  }

  function refreshThemeInputs() {
    themeBgColor.value = theme.background.color;
    themeCardRoot.value = theme.cardRoot;
    themeCardChild.value = theme.cardChild;
    themeCardParallel.value = theme.cardParallel;
    setSwatch(swatches.background, theme.background.color);
    setSwatch(swatches.cardRoot, theme.cardRoot);
    setSwatch(swatches.cardChild, theme.cardChild);
    setSwatch(swatches.cardParallel, theme.cardParallel);
    const pct = Math.round(theme.background.imageOpacity * 100);
    themeBgOpacity.value = String(pct);
    themeBgOpacityVal.textContent = pct + '%';
  }

  function setThemeStatus(msg, isError) {
    themeStatus.textContent = msg || '';
    themeStatus.className = 'theme-status' + (isError ? ' err' : '');
  }

  function scheduleThemeSave(delay) {
    clearTimeout(themeSaveTimer);
    themeSaveTimer = setTimeout(saveTheme, delay == null ? 450 : delay);
  }

  async function saveTheme() {
    if (location.protocol === 'file:') return;
    setThemeStatus('保存中…');
    try {
      const body = { theme };
      if (pendingImageData) body.imageData = pendingImageData;
      const res = await fetch('/api/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
      theme = sanitizeThemeClient(json.theme || theme);
      pendingImageData = null;
      applyTheme(theme);
      writeThemeCache(theme);
      setThemeStatus('已保存到 package.json');
    } catch (err) {
      setThemeStatus('保存失败：' + err.message, true);
    }
  }

  async function loadTheme() {
    if (location.protocol === 'file:') {
      applyTheme(theme);
      return;
    }
    try {
      const res = await fetch('/api/theme', { cache: 'no-store' });
      const json = await res.json();
      if (res.ok && json && json.theme) {
        theme = sanitizeThemeClient(json.theme);
        writeThemeCache(theme);
      }
    } catch {
      /* 用本地缓存 / 默认值 */
    }
    applyTheme(theme);
  }

  function bindHexInput(input, key) {
    input.addEventListener('input', () => {
      const v = normalizeHex(input.value, null);
      if (!v) {
        input.classList.add('invalid');
        return;
      }
      input.classList.remove('invalid');
      if (key === 'background') theme.background.color = v;
      else theme[key] = v;
      setSwatch(swatches[key], v);
      applyTheme(theme);
      writeThemeCache(theme);
      scheduleThemeSave();
    });
    input.addEventListener('blur', () => {
      input.classList.remove('invalid');
      input.value = key === 'background' ? theme.background.color : theme[key];
    });
  }

  function initThemePanel() {
    applyTheme(theme);

    bindHexInput(themeBgColor, 'background');
    bindHexInput(themeCardRoot, 'cardRoot');
    bindHexInput(themeCardChild, 'cardChild');
    bindHexInput(themeCardParallel, 'cardParallel');

    themeBgOpacity.addEventListener('input', () => {
      theme.background.imageOpacity = Number(themeBgOpacity.value) / 100;
      themeBgOpacityVal.textContent = themeBgOpacity.value + '%';
      applyTheme(theme);
      writeThemeCache(theme);
      scheduleThemeSave();
    });

    themeBgImage.addEventListener('change', () => {
      const file = themeBgImage.files && themeBgImage.files[0];
      if (!file) return;
      if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) {
        setThemeStatus('仅支持 PNG / JPEG / GIF / WebP / BMP', true);
        themeBgImage.value = '';
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setThemeStatus('图片过大（上限 8MB）', true);
        themeBgImage.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        pendingImageData = safeImageUrl(String(reader.result)) || null;
        applyTheme(theme);
        scheduleThemeSave(0);
        themeBgImage.value = '';
      };
      reader.onerror = () => setThemeStatus('图片读取失败', true);
      reader.readAsDataURL(file);
    });

    themeBgClear.addEventListener('click', () => {
      pendingImageData = null;
      theme.background.image = '';
      applyTheme(theme);
      writeThemeCache(theme);
      scheduleThemeSave(0);
    });

    themeReset.addEventListener('click', () => {
      theme = cloneTheme(THEME_DEFAULTS);
      pendingImageData = null;
      applyTheme(theme);
      refreshThemeInputs();
      writeThemeCache(theme);
      scheduleThemeSave(0);
    });

    themeBtn.addEventListener('click', () => {
      themePanel.hidden = !themePanel.hidden;
      if (!themePanel.hidden) refreshThemeInputs();
    });
    themeClose.addEventListener('click', () => {
      themePanel.hidden = true;
    });
  }

  /* ---------------- init ---------------- */

  async function init() {
    render();
    initPanning();
    initSelectionButton();
    initAttachments();
    initThemePanel();
    loadTheme();
    if (state.roots.length) centerView();

    if (location.protocol === 'file:') {
      showBanner(
        '当前是直接打开本地文件（file://），后端接口无法访问。请先在本目录运行 <code>node server.mjs</code>，再打开 <code>http://localhost:3000</code>。'
      );
      return;
    }

    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const info = await res.json();
      if (!res.ok || !info || !info.ok) throw new Error('health check failed');
      if (!info.keyConfigured) {
        showBanner(
          '后端已连接，但未检测到 DEEPSEEK_API_KEY。请编辑项目根目录的 <code>.env</code> 填入 Key，然后重启服务。'
        );
      } else {
        showBanner(
          '已连接后端 · 模型 <b>' +
            escapeHtml(info.model || '') +
            '</b> · 密钥来源 ' +
            escapeHtml(info.keySource || '') +
            ' <code>****' +
            escapeHtml(info.keyTail || '') +
            '</code> · 输出上限 ' +
            escapeHtml(String(info.maxTokens || '')) +
            ' tokens',
          true
        );
        setTimeout(hideBanner, 6000);
      }
    } catch {
      showBanner(
        '无法连接后端服务（<code>/api/health</code> 无响应）。请确认已运行 <code>node server.mjs</code>，并且是通过 <code>http://localhost:3000</code> 访问本页面。'
      );
    }
  }

  init();
})();
