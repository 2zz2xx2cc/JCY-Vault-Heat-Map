/*
 * Vault Heatmap Plugin
 * 展示整个仓库中文档改动的热力图。
 * 数据来源：vault 中所有 markdown 文件的 stat.mtime（实际文件修改时间）。
 * 同时兼容读取 easy-keep-view 的 notesDB 作为补充数据源。
 *
 * v2：在热力图下方新增 Sparkline 横条（仿 vault-pulse），
 *     展示过去 30 天每天的文件改动数，点击跳转到热力图对应日期。
 */

const { Plugin, ItemView, TFile, Notice, debounce, setTooltip } = require('obsidian');

const VIEW_TYPE_HEATMAP = 'vault-heatmap-view';

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 将时间戳格式化为 YYYY-MM-DD */
function toDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 将 YYYY-MM-DD 解析为本地 Date（00:00:00） */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 获取某天是周几（0=周日，1=周一…） */
function getDow(dateStr) {
  return parseDate(dateStr).getDay();
}

/** 生成从 startStr 到 endStr 的所有日期字符串数组 */
function dateRange(startStr, endStr) {
  const result = [];
  const cur = parseDate(startStr);
  const end = parseDate(endStr);
  while (cur <= end) {
    result.push(toDateStr(cur.getTime()));
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

/** 获取 N 天前的日期字符串 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateStr(d.getTime());
}

/** 月份短名 */
const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const DOW_NAMES = ['日','一','二','三','四','五','六'];

// ─── Sparkline 工具函数（仿 vault-pulse）────────────────────────────────────

/**
 * 计算分位数桶（仿 vault-pulse _n / es）
 * 输入：dayMap（Map<iso, {count, files}>），days：天数
 * 输出：{ p25, p50, p75 }
 */
function computeSparklineBuckets(dayMap, today, days) {
  const counts = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(parseDate(today));
    d.setDate(d.getDate() - i);
    const iso = toDateStr(d.getTime());
    const c = dayMap.get(iso)?.count ?? 0;
    if (c > 0) counts.push(c);
  }
  counts.sort((a, b) => a - b);
  if (counts.length === 0) return { p25: 0, p50: 0, p75: 0 };
  return {
    p25: percentile(counts, 0.25),
    p50: percentile(counts, 0.50),
    p75: percentile(counts, 0.75),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const frac = idx - lo;
  return lo + 1 < sorted.length
    ? sorted[lo] + frac * (sorted[lo + 1] - sorted[lo])
    : sorted[lo];
}

/**
 * 根据分位数桶计算颜色等级 0-4（完全仿 vault-pulse Ve 函数）
 */
function calcSparklineLevel(count, buckets) {
  if (count <= 0) return 0;
  const { p25, p50, p75 } = buckets;
  if (p25 === p75 && p50 === p75) return count >= p50 ? 4 : 2;
  if (count <= p25) return 1;
  if (count <= p50) return 2;
  if (count <= p75) return 3;
  return 4;
}

/**
 * 渲染 Sparkline 横条（仿 vault-pulse nr 函数）
 *
 * @param {HTMLElement} container  - 挂载容器
 * @param {Map}         dayMap     - 日期 → { count, files }
 * @param {string}      today      - 今天的 YYYY-MM-DD
 * @param {number}      days       - 展示天数（默认 30）
 * @param {Function}    onSelect   - 点击回调 (iso: string) => void
 */
function renderSparkline(container, dayMap, today, days, onSelect) {
  container.empty();

  // 构建数据数组（从最早到最新，左→右）
  const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(parseDate(today));
    d.setDate(d.getDate() - i);
    const iso = toDateStr(d.getTime());
    const count = dayMap.get(iso)?.count ?? 0;
    data.push({ iso, count, dayOffset: i });
  }

  const buckets = computeSparklineBuckets(dayMap, today, days);
  const maxCount = Math.max(1, ...data.map(d => d.count));

  // 渲染每根柱子
  data.forEach((day, idx) => {
    const bar = container.createDiv({ cls: 'vhm-sparkline-bar' });
    const level = calcSparklineLevel(day.count, buckets);
    const heightPct = day.count === 0 ? 6 : 15 + (day.count / maxCount) * 85;

    bar.dataset.date  = day.iso;
    bar.dataset.count = String(day.count);
    bar.dataset.level = String(level);
    bar.setAttribute('role', 'button');
    bar.tabIndex = -1;
    bar.setCssProps({
      '--vhm-bar-height': `${heightPct}%`,
      '--vhm-bar-idx':    String(idx),
    });

    if (day.count > 0) bar.classList.add('is-active');

    // Tooltip（mouseover 时设置）
    bar.addEventListener('mouseover', () => {
      const tip = day.count === 0
        ? `${day.iso}  ·  无改动`
        : `${day.iso}  ·  ${day.count} 个文件`;
      setTooltip(bar, tip, { placement: 'top' });
    });

    // 点击 → 回调（高亮热力图 + 展示详情）
    if (day.count > 0) {
      bar.addEventListener('click', () => onSelect(day.iso));
    }
  });
}

// ─── 热力图视图 ──────────────────────────────────────────────────────────────

class HeatmapView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_HEATMAP; }
  getDisplayText() { return '仓库改动热力图'; }
  getIcon() { return 'activity'; }

  async onOpen() {
    await this.render();
  }

  async onClose() {}

  async render() {
    const root = this.containerEl;
    root.empty();
    root.addClass('vault-heatmap-root');

    // ── 收集数据 ──────────────────────────────────────────────────────────
    // key: YYYY-MM-DD, value: { count, files: [{name, path, mtime}] }
    const dayMap = new Map();

    const allFiles = this.app.vault.getMarkdownFiles();
    for (const file of allFiles) {
      const dateStr = toDateStr(file.stat.mtime);
      if (!dayMap.has(dateStr)) dayMap.set(dateStr, { count: 0, files: [] });
      const entry = dayMap.get(dateStr);
      entry.count++;
      entry.files.push({ name: file.basename, path: file.path, mtime: file.stat.mtime });
    }

    // 直接使用插件自身维护的访问记录
    const getVisitedMap = () => this.plugin.visitedMap;

    // ── 确定时间范围 ──────────────────────────────────────────────────────
    const today = toDateStr(Date.now());
    // 默认展示最近 365 天
    const rangeOptions = [
      { label: '近 3 个月', days: 90 },
      { label: '近 6 个月', days: 180 },
      { label: '近 1 年', days: 365 },
      { label: '近 2 年', days: 730 },
      { label: '全部', days: null },
    ];

    // ── 顶部工具栏 ────────────────────────────────────────────────────────
    const toolbar = root.createDiv('vhm-toolbar');

    const titleEl = toolbar.createDiv('vhm-title');
    titleEl.setText('仓库改动热力图');

    const statsEl = toolbar.createDiv('vhm-stats');

    const rangeBar = toolbar.createDiv('vhm-range-bar');
    let currentDays = 365;

    // ── 全局浮动 Tooltip（挂在 root 下，避免被 overflow 裁剪） ────────────────
    const floatTip = root.createDiv('vhm-tooltip-float');
    floatTip.style.display = 'none';

    const showTip = (cell, text) => {
      floatTip.setText(text);
      floatTip.style.display = 'block';
      const cellRect = cell.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      // 展示在格子正下方
      const tipLeft = cellRect.left - rootRect.left + cellRect.width / 2;
      const tipTop  = cellRect.bottom - rootRect.top + 6;
      floatTip.style.left = tipLeft + 'px';
      floatTip.style.top  = tipTop  + 'px';
    };
    const hideTip = () => { floatTip.style.display = 'none'; };

    // ── 主体容器（热力图 + 详情面板） ────────────────────────────────────
    const bodyWrap = root.createDiv('vhm-body-wrap');

    // ── 热力图容器 ────────────────────────────────────────────────────────
    const heatmapWrap = bodyWrap.createDiv('vhm-heatmap-wrap');

    // ── 文件列表面板 ──────────────────────────────────────────────────────
    const detailPanel = bodyWrap.createDiv('vhm-detail-panel');
    detailPanel.createDiv('vhm-detail-placeholder').setText('点击某一天查看当天改动的文件');

    // ── 渲染函数 ──────────────────────────────────────────────────────────
    // grid 引用（供 sparkline 点击时高亮格子用）
    let gridEl = null;

    const renderHeatmap = (days) => {
      heatmapWrap.empty();
      heatmapWrap.style.height = '';
      heatmapWrap.style.flex = '';
      detailPanel.empty();
      detailPanel.style.height = '';
      detailPanel.removeClass('is-expanded');
      detailPanel.createDiv('vhm-detail-placeholder').setText('点击某一天查看当天改动的文件');

      // 计算起止日期
      let startStr;
      if (days === null) {
        // 全部：找最早的文件日期
        let earliest = today;
        for (const [d] of dayMap) { if (d < earliest) earliest = d; }
        // 从最早那周的周日开始
        const earliestDate = parseDate(earliest);
        const dow = earliestDate.getDay(); // 0=Sun
        earliestDate.setDate(earliestDate.getDate() - dow);
        startStr = toDateStr(earliestDate.getTime());
      } else {
        startStr = daysAgo(days - 1);
        // 往前对齐到周日
        const sd = parseDate(startStr);
        sd.setDate(sd.getDate() - sd.getDay());
        startStr = toDateStr(sd.getTime());
      }

      const dates = dateRange(startStr, today);

      // 统计数据
      let totalEdits = 0;
      let maxCount = 0;
      for (const [d, v] of dayMap) {
        if (d >= startStr && d <= today) {
          totalEdits += v.count;
          if (v.count > maxCount) maxCount = v.count;
        }
      }

      // 更新统计栏
      const activeDays = [...dayMap.keys()].filter(d => d >= startStr && d <= today).length;
      statsEl.empty();
      statsEl.createSpan({ cls: 'vhm-stat-item', text: `共 ${totalEdits} 次改动` });
      statsEl.createSpan({ cls: 'vhm-stat-sep', text: '·' });
      statsEl.createSpan({ cls: 'vhm-stat-item', text: `活跃 ${activeDays} 天` });
      statsEl.createSpan({ cls: 'vhm-stat-sep', text: '·' });
      statsEl.createSpan({ cls: 'vhm-stat-item', text: `共 ${allFiles.length} 个文件` });

      // 按周分组
      const weeks = [];
      let week = [];
      for (const d of dates) {
        week.push(d);
        if (getDow(d) === 6) { // 周六结束一周
          weeks.push(week);
          week = [];
        }
      }
      if (week.length > 0) weeks.push(week);

      // 色阶：0 → 5 级
      const getLevel = (count) => {
        if (count === 0) return 0;
        if (maxCount === 0) return 0;
        const ratio = count / maxCount;
        if (ratio <= 0.15) return 1;
        if (ratio <= 0.35) return 2;
        if (ratio <= 0.60) return 3;
        if (ratio <= 0.85) return 4;
        return 5;
      };

      // ── 月份标签行 ──────────────────────────────────────────────────────
      const monthRow = heatmapWrap.createDiv('vhm-month-row');
      // 左侧星期标签占位
      monthRow.createDiv('vhm-dow-spacer');

      const monthsGrid = monthRow.createDiv('vhm-months-grid');
      // 计算每列（周）对应的月份，在月份切换时显示标签
      let lastMonth = -1;
      for (let wi = 0; wi < weeks.length; wi++) {
        const firstDay = weeks[wi][0];
        const month = parseDate(firstDay).getMonth();
        const cell = monthsGrid.createDiv('vhm-month-cell');
        if (month !== lastMonth) {
          cell.setText(MONTH_NAMES[month]);
          lastMonth = month;
        }
      }

      // ── 主体：星期标签 + 格子 ────────────────────────────────────────────
      const body = heatmapWrap.createDiv('vhm-body');

      // 星期标签列
      const dowCol = body.createDiv('vhm-dow-col');
      // 只显示 一、三、五
      for (let i = 0; i < 7; i++) {
        const label = dowCol.createDiv('vhm-dow-label');
        label.setText([1, 3, 5].includes(i) ? DOW_NAMES[i] : '');
      }

      // 格子区域
      const grid = body.createDiv('vhm-grid');
      gridEl = grid; // 保存引用供 sparkline 使用

      for (const week of weeks) {
        const col = grid.createDiv('vhm-week-col');
        // 如果这周不是从周日开始（第一周可能不完整），补空格
        const startDow = getDow(week[0]);
        for (let i = 0; i < startDow; i++) {
          col.createDiv('vhm-cell vhm-cell-empty');
        }
        for (const dateStr of week) {
          const entry = dayMap.get(dateStr);
          const count = entry ? entry.count : 0;
          const level = getLevel(count);
          const isFuture = dateStr > today;

          const cell = col.createDiv(`vhm-cell vhm-cell-l${level}${isFuture ? ' vhm-cell-future' : ''}`);
          cell.dataset.date = dateStr;
          cell.dataset.count = String(count);

          // Tooltip
          const tipText = isFuture ? dateStr
            : count === 0 ? `${dateStr}  无改动`
            : `${dateStr}  ${count} 个文件改动`;
          cell.addEventListener('mouseenter', () => showTip(cell, tipText));
          cell.addEventListener('mouseleave', hideTip);

          // 点击展示文件列表
          if (!isFuture && count > 0) {
            cell.addClass('vhm-cell-clickable');
            cell.addEventListener('click', () => {
              selectDate(dateStr, entry.files);
            });
          }
        }
      }

      // ── Sparkline 横条（仿 vault-pulse，在图例上方）────────────────────
      const sparklineWrap = heatmapWrap.createDiv('vhm-sparkline');

      // sparkline 展示天数：与当前时间范围完全一致
      // days === null（全部）时，用实际日期跨度天数
      const sparkDays = days === null ? dates.length : days;

      renderSparkline(sparklineWrap, dayMap, today, sparkDays, (iso) => {
        // 点击 sparkline 柱子 → 高亮热力图对应格子 + 展示详情
        const entry = dayMap.get(iso);
        if (!entry) return;

        // 高亮热力图格子
        if (gridEl) {
          gridEl.querySelectorAll('.vhm-cell-selected').forEach(el => el.removeClass('vhm-cell-selected'));
          const targetCell = gridEl.querySelector(`.vhm-cell[data-date="${iso}"]`);
          if (targetCell) {
            targetCell.addClass('vhm-cell-selected');
            // 滚动到可见区域
            targetCell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          }
        }

        // 展示文件详情
        showDetail(iso, entry.files);
      });

      // ── 图例 ────────────────────────────────────────────────────────────
      const legend = heatmapWrap.createDiv('vhm-legend');
      legend.createSpan({ cls: 'vhm-legend-label', text: '少' });
      for (let i = 0; i <= 5; i++) {
        legend.createDiv(`vhm-cell vhm-cell-l${i} vhm-legend-cell`);
      }
      legend.createSpan({ cls: 'vhm-legend-label', text: '多' });
    };

    // ── 选中日期（热力图格子点击 / sparkline 点击共用）────────────────────
    const selectDate = (dateStr, files) => {
      // 高亮格子
      if (gridEl) {
        gridEl.querySelectorAll('.vhm-cell-selected').forEach(el => el.removeClass('vhm-cell-selected'));
        const targetCell = gridEl.querySelector(`.vhm-cell[data-date="${dateStr}"]`);
        if (targetCell) targetCell.addClass('vhm-cell-selected');
      }
      showDetail(dateStr, files);
    };

    // ── 文件详情面板 ──────────────────────────────────────────────────────
    // 记录当前展示的状态，用于 file-open 后实时刷新
    let currentDetail = null; // { dateStr, files }

    const showDetail = (dateStr, files) => {
      currentDetail = { dateStr, files };
      detailPanel.empty();

      // 动态计算高度：先锁定热力图当前高度，再把剩余空间给详情面板
      requestAnimationFrame(() => {
        const bodyH = bodyWrap.offsetHeight;
        // 读取热力图内容的自然高度并固定，防止被详情面板挤压
        const heatmapNaturalH = heatmapWrap.scrollHeight;
        // 热力图最少保留自身高度，最多占 bodyWrap 的 60%
        const heatmapH = Math.min(heatmapNaturalH, Math.floor(bodyH * 0.6));
        heatmapWrap.style.height = heatmapH + 'px';
        heatmapWrap.style.flex = 'none';
        // 详情面板占剩余空间，至少 100px
        const panelH = Math.max(100, bodyH - heatmapH);
        detailPanel.style.height = panelH + 'px';
        detailPanel.addClass('is-expanded');
      });

      const header = detailPanel.createDiv('vhm-detail-header');
      header.createSpan({ cls: 'vhm-detail-date', text: dateStr });
      header.createSpan({ cls: 'vhm-detail-count', text: `${files.length} 个文件` });

      const list = detailPanel.createDiv('vhm-detail-list');

      // 按 mtime 降序排列
      const sorted = [...files].sort((a, b) => b.mtime - a.mtime);

      for (const f of sorted) {
        const item = list.createDiv('vhm-detail-item');

        const nameEl = item.createDiv('vhm-detail-name');
        nameEl.setText(f.name);

        const timeEl = item.createDiv('vhm-detail-time');
        const d = new Date(f.mtime);
        timeEl.setText(`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`);

        // 显示「已访问」标记
        if (getVisitedMap().has(f.path)) {
          item.createDiv('vhm-detail-badge').setText('已访问');
        }

        item.addEventListener('click', async () => {
          const file = this.app.vault.getAbstractFileByPath(f.path);
          if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(file);
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
          }
        });
      }
    };

    // ── 监听文件打开事件，实时刷新「已访问」标记 ──────────────────────────
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file) return;
        // 如果详情面板正在展示，刷新列表
        if (currentDetail) {
          showDetail(currentDetail.dateStr, currentDetail.files);
        }
      })
    );

    // ── 范围切换按钮 ──────────────────────────────────────────────────────
    const buttons = [];
    for (const opt of rangeOptions) {
      const btn = rangeBar.createEl('button', { cls: 'vhm-range-btn', text: opt.label });
      buttons.push({ btn, days: opt.days });
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.btn.removeClass('vhm-range-btn-active'));
        btn.addClass('vhm-range-btn-active');
        currentDays = opt.days;
        renderHeatmap(currentDays);
      });
    }
    // 默认激活"近 1 年"
    buttons[2].btn.addClass('vhm-range-btn-active');

    // 初始渲染
    renderHeatmap(currentDays);
  }
}

// ─── 主插件 ──────────────────────────────────────────────────────────────────

class VaultHeatmapPlugin extends Plugin {
  async onload() {
    // ── 加载访问记录 ────────────────────────────────────────────────────
    const data = await this.loadData();
    // visitedMap: path -> timestamp（最近一次访问时间）
    this.visitedMap = new Map(Object.entries(data?.visited ?? {}));

    // ── 持久化访问记录（防抖，避免频繁写盘） ────────────────────────────
    this.saveVisitedDebounced = debounce(async () => {
      const visited = Object.fromEntries(this.visitedMap);
      await this.saveData({ visited });
    }, 2000);

    // ── 监听文件打开，记录访问 ──────────────────────────────────────────
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file || !(file instanceof TFile)) return;
        this.visitedMap.set(file.path, Date.now());
        this.saveVisitedDebounced();
      })
    );

    this.registerView(VIEW_TYPE_HEATMAP, leaf => new HeatmapView(leaf, this));

    // Ribbon 按钮
    this.addRibbonIcon('activity', '仓库改动热力图', () => {
      this.activateView();
    });

    // 命令
    this.addCommand({
      id: 'open-vault-heatmap',
      name: '打开仓库改动热力图',
      callback: () => this.activateView(),
    });

    // 监听文件修改，如果热力图已打开则刷新
    this.refreshDebounced = debounce(() => this.refreshIfOpen(), 1000);
    this.registerEvent(this.app.vault.on('modify', () => this.refreshDebounced()));
    this.registerEvent(this.app.vault.on('create', () => this.refreshDebounced()));
    this.registerEvent(this.app.vault.on('delete', () => this.refreshDebounced()));

    console.log('[VaultHeatmap] 插件已加载');
  }

  onunload() {
    console.log('[VaultHeatmap] 插件已卸载');
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HEATMAP);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      await existing[0].view.render();
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_HEATMAP, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async refreshIfOpen() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_HEATMAP);
    if (leaves.length > 0) {
      await leaves[0].view.render();
    }
  }
}

module.exports = VaultHeatmapPlugin;
