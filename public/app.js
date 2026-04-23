/**
 * CBT-I 睡眠日记 · 主应用前端
 * - 一周 7 列宽表（与早期 index.html 一致），按字段填写
 * - 每格输入会被防抖收集，按"日期"批量 PUT 到后端，按用户独立存储
 * - 自动计算 TIB / TST / SE，绘制 4 张 Chart.js 趋势图
 */

(function () {
  // ---------- DOM 简写 ----------
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // ---------- 字段定义 ----------
  const FIELDS = [
    { type: 'section', label: '一、夜间睡眠' },
    { id: 'bedTime',   label: '上床时间',       hint: '躺到床上的时刻',    input: 'time' },
    { id: 'sleepTime', label: '入睡时间',       hint: '真正睡着的时刻',    input: 'time' },
    { id: 'awakenings',label: '夜间醒来次数',   hint: '不含最终醒来',      input: 'number', min: 0, max: 30, step: 1 },
    { id: 'waso',      label: '夜醒总时长',     hint: 'WASO（分钟）',      input: 'number', min: 0, max: 720, step: 5 },
    { id: 'finalWake', label: '最终醒来时间',   hint: '不再入睡的时刻',    input: 'time' },
    { id: 'outOfBed',  label: '离开床时间',     hint: '双脚离开床的时刻',  input: 'time' },

    { type: 'section', label: '二、自动计算' },
    { id: 'tib', label: 'TIB 在床时间',  hint: '离床 − 上床',           computed: true },
    { id: 'tst', label: 'TST 总睡眠',    hint: '减去入睡潜伏与夜醒',    computed: true },
    { id: 'se',  label: 'SE 睡眠效率',   hint: 'TST ÷ TIB · 目标 ≥ 85%', computed: true },
  ];

  // ---------- 时间工具 ----------
  const DAYS_CN = ['周日','周一','周二','周三','周四','周五','周六'];
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  function parseYMD(s) { const [y,m,d]=s.split('-').map(Number); const x=new Date(y,m-1,d); x.setHours(0,0,0,0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
  function fmtMonthDay(d) { return `${d.getMonth()+1}月${d.getDate()}日`; }
  function weekdayCN(d) { return DAYS_CN[d.getDay()]; }

  function diffMinutes(start, end) {
    if (!start || !end) return null;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let s = sh * 60 + sm, e = eh * 60 + em;
    if (e <= s) e += 24 * 60;
    return e - s;
  }
  function minToHHMM(m) {
    if (m == null || isNaN(m)) return '—';
    const h = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    return `${h}h${mm > 0 ? mm + 'm' : ''}`;
  }

  // 单日派生指标
  // TIB = 离床 − 上床
  // SOL = 入睡 − 上床（从两个时间字段算出）
  // 早醒赖床 = 离床 − 最终醒来
  // TST = TIB − SOL − WASO − 早醒赖床
  // SE  = TST ÷ TIB
  function computeDay(rec) {
    if (!rec) return { tibMin: null, tstMin: null, solMin: null, se: null };
    const tibMin   = diffMinutes(rec.bedTime, rec.outOfBed);
    const solMin   = diffMinutes(rec.bedTime, rec.sleepTime);
    const earlyMin = diffMinutes(rec.finalWake, rec.outOfBed);
    const waso     = parseFloat(rec.waso) || 0;
    let tstMin = null;
    if (tibMin != null) {
      tstMin = Math.max(0, tibMin - (solMin || 0) - waso - (earlyMin || 0));
    }
    const se = (tibMin && tstMin != null) ? (tstMin / tibMin * 100) : null;
    return { tibMin, tstMin, solMin, se };
  }

  function seClassPct(pct) {
    if (pct == null) return '';
    if (pct >= 85) return 'good';
    if (pct >= 75) return 'warn';
    return 'bad';
  }

  // ---------- API ----------
  const API = {
    me:     () => fetch('/api/me').then(handle),
    list:   () => fetch('/api/entries').then(handle),
    upsert: (date, body) => fetch(`/api/entries/${date}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(handle),
    logout:    () => fetch('/api/logout', { method: 'POST' }).then(handle),
    exportUrl: '/api/export',
  };
  async function handle(res) {
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  // ---------- 全局状态 ----------
  let entries = {};                      // { 'YYYY-MM-DD': { ... } }
  const DEFAULT_START = '2026-04-23';   // 默认从 4-23 开始一周
  let currentWeekStart = parseYMD(DEFAULT_START);
  let rangeDays = 14;                    // 趋势图时间范围（天）
  const pendingByDate = new Map();       // 待保存的字段 { date -> { field: value|null } }
  const saveTimers   = new Map();        // 防抖定时器

  // ---------- 初始化 ----------
  init().catch(err => toast(err.message, 'error'));

  async function init() {
    const me = await API.me();
    if (!me) return;
    $('#usernameLabel').textContent = me.username;

    $('#btnLogout').addEventListener('click', async () => {
      await API.logout(); window.location.href = '/login';
    });
    $('#btnExport').addEventListener('click', () => { window.location.href = API.exportUrl; });

    $('#prevWeek').addEventListener('click', () => { currentWeekStart = addDays(currentWeekStart, -7); renderWeek(); });
    $('#nextWeek').addEventListener('click', () => { currentWeekStart = addDays(currentWeekStart,  7); renderWeek(); });
    $('#weekStart').addEventListener('change', (e) => {
      if (!e.target.value) return;
      currentWeekStart = parseYMD(e.target.value);
      renderWeek();
    });

    $$('#rangeBar button').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#rangeBar button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        rangeDays = parseInt(btn.dataset.days, 10);
        renderCharts();
      });
    });

    await reloadAll();
  }

  async function reloadAll() {
    const data = await API.list();
    entries = data.entries || {};
    renderWeek();
    renderCharts();
  }

  // ---------- 渲染：一周 7 列表 ----------
  function renderWeek() {
    const table = $('#diaryTable');
    const thead = table.querySelector('thead tr');
    const tbody = table.querySelector('tbody');

    // 清空除"项目"列以外的表头
    while (thead.children.length > 1) thead.removeChild(thead.lastChild);
    tbody.innerHTML = '';

    // 7 个日期列
    for (let i = 0; i < 7; i++) {
      const d = addDays(currentWeekStart, i);
      const th = document.createElement('th');
      th.className = 'day-col';
      th.innerHTML = `${fmtMonthDay(d)}<span class="weekday">${weekdayCN(d)}</span>`;
      thead.appendChild(th);
    }

    // 行
    FIELDS.forEach(f => {
      const tr = document.createElement('tr');
      if (f.type === 'section') {
        tr.className = 'section-sep';
        const td = document.createElement('td');
        td.colSpan = 8; td.textContent = f.label;
        tr.appendChild(td); tbody.appendChild(tr);
        return;
      }

      const labelTd = document.createElement('td');
      labelTd.className = 'field-label';
      labelTd.innerHTML = `${f.label}${f.hint ? `<small>${f.hint}</small>` : ''}`;
      tr.appendChild(labelTd);

      for (let i = 0; i < 7; i++) {
        const d = addDays(currentWeekStart, i);
        const dateKey = ymd(d);
        const td = document.createElement('td');
        td.dataset.date = dateKey;
        td.dataset.field = f.id;

        if (f.computed) {
          td.classList.add('computed');
          td.textContent = '—';
        } else {
          const val = (entries[dateKey] && entries[dateKey][f.id] != null) ? entries[dateKey][f.id] : '';
          let el;
          if (f.input === 'select') {
            el = document.createElement('select');
            f.options.forEach(opt => {
              const o = document.createElement('option');
              o.value = opt; o.textContent = opt === '' ? '—' : opt;
              if (String(opt) === String(val)) o.selected = true;
              el.appendChild(o);
            });
          } else {
            el = document.createElement('input');
            el.type = f.input || 'text';
            el.value = val === undefined || val === null ? '' : val;
            if (f.placeholder) el.placeholder = f.placeholder;
            if (f.min  != null) el.min  = f.min;
            if (f.max  != null) el.max  = f.max;
            if (f.step != null) el.step = f.step;
          }
          el.addEventListener('input', () => onCellChange(dateKey, f, el.value));
          el.addEventListener('change', () => onCellChange(dateKey, f, el.value));
          td.appendChild(el);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    // 顶部范围标签 / 日期选择器
    const endD = addDays(currentWeekStart, 6);
    $('#weekLabel').textContent = `${fmtMonthDay(currentWeekStart)} – ${fmtMonthDay(endD)}`;
    $('#weekStart').value = ymd(currentWeekStart);

    recomputeWeek();
    renderWeekSummary();
  }

  function onCellChange(dateKey, field, value) {
    // 数值字段做转换；空字符串 = 删除该字段
    let v = value;
    if (field.input === 'number') {
      v = (value === '') ? '' : parseFloat(value);
      if (isNaN(v)) v = '';
    }
    if (!entries[dateKey]) entries[dateKey] = {};
    if (v === '' || v === null) delete entries[dateKey][field.id];
    else entries[dateKey][field.id] = v;

    // 累积到防抖队列
    if (!pendingByDate.has(dateKey)) pendingByDate.set(dateKey, {});
    pendingByDate.get(dateKey)[field.id] = (v === '' || v === null) ? '' : v;

    // 重算 + 重画汇总 / 图表
    recomputeWeek();
    renderWeekSummary();
    renderCharts();

    // 防抖保存（每个日期独立，200ms 内合并）
    setSaveStatus('保存中…');
    if (saveTimers.has(dateKey)) clearTimeout(saveTimers.get(dateKey));
    saveTimers.set(dateKey, setTimeout(() => flushSave(dateKey), 200));
  }

  // 关页 / 刷新前，把所有还没发出去的请求用 sendBeacon 同步送出
  window.addEventListener('beforeunload', () => {
    for (const [dateKey, payload] of pendingByDate.entries()) {
      try {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        // sendBeacon 不支持 PUT，所以用 POST 别名（服务端同时支持）
        navigator.sendBeacon(`/api/entries/${dateKey}?_method=PUT`, blob);
      } catch {}
    }
  });

  async function flushSave(dateKey) {
    const payload = pendingByDate.get(dateKey);
    if (!payload) return;
    pendingByDate.delete(dateKey);
    saveTimers.delete(dateKey);
    try {
      await API.upsert(dateKey, payload);
      setSaveStatus('已保存 ✓');
    } catch (e) {
      setSaveStatus('保存失败');
      toast(e.message, 'error');
    }
  }

  function setSaveStatus(text) {
    const el = $('#saveStatus');
    el.textContent = text;
    el.style.color = text.endsWith('✓') ? 'var(--good)' : (text === '保存失败' ? 'var(--bad)' : 'var(--muted)');
    if (text.endsWith('✓')) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 1500);
  }

  // 重算"三、自动计算"那 3 行
  function recomputeWeek() {
    for (let i = 0; i < 7; i++) {
      const dateKey = ymd(addDays(currentWeekStart, i));
      const { tibMin, tstMin, se } = computeDay(entries[dateKey]);
      setComputedCell(dateKey, 'tib', tibMin != null ? minToHHMM(tibMin) : '—', null);
      setComputedCell(dateKey, 'tst', tstMin != null ? minToHHMM(tstMin) : '—', null);
      setComputedCell(dateKey, 'se',  se != null ? `${se.toFixed(0)}%` : '—', seClassPct(se));
    }
  }
  function setComputedCell(dateKey, field, text, cls) {
    const td = document.querySelector(`td.computed[data-date="${dateKey}"][data-field="${field}"]`);
    if (!td) return;
    td.textContent = text;
    td.className = 'computed' + (cls ? ' ' + cls : '');
  }

  // 本周汇总
  function renderWeekSummary() {
    let n=0, sumTib=0, sumTst=0, sumSe=0, nSe=0, sumSol=0, nSol=0, sumWaso=0, nWaso=0, sumAwk=0, nAwk=0;
    for (let i = 0; i < 7; i++) {
      const k = ymd(addDays(currentWeekStart, i));
      const r = entries[k]; if (!r) continue;
      const { tibMin, tstMin, solMin, se } = computeDay(r);
      if (tibMin != null) { n++; sumTib += tibMin; }
      if (tstMin != null) sumTst += tstMin;
      if (se != null) { sumSe += se; nSe++; }
      if (solMin != null) { sumSol  += solMin; nSol++; }
      if (r.waso != null && r.waso !== '') { sumWaso += parseFloat(r.waso) || 0; nWaso++; }
      if (r.awakenings != null && r.awakenings !== '') { sumAwk += parseFloat(r.awakenings) || 0; nAwk++; }
    }
    const set = (k, v) => {
      const el = document.querySelector(`#weekSummary [data-k="${k}"]`);
      if (el) el.innerHTML = v;
    };
    set('count',  `${n}<small> / 7</small>`);
    set('avgTib', n ? minToHHMM(sumTib / n) : '—');
    set('avgTst', n ? minToHHMM(sumTst / n) : '—');
    const avgSe = nSe ? sumSe / nSe : null;
    set('avgSe',  avgSe != null ? `${avgSe.toFixed(0)}<small>%</small>` : '—');
    set('avgSol', nSol  ? `${Math.round(sumSol  / nSol)}<small> 分</small>` : '—');
    set('avgWaso',nWaso ? `${Math.round(sumWaso / nWaso)}<small> 分</small>` : '—');
    set('avgAwk', nAwk  ? `${(sumAwk / nAwk).toFixed(1)}<small> 次</small>` : '—');

    const seCard = document.querySelector('#weekSummary .metric:nth-child(4)');
    seCard.classList.remove('good','warn','bad');
    const c = seClassPct(avgSe);
    if (c) seCard.classList.add(c);
  }

  // ---------- 图表 ----------
  let chartSE, chartTST, chartSolWaso, chartWeekly;

  function renderCharts() {
    const today = new Date(); today.setHours(0,0,0,0);
    const start = addDays(today, -(rangeDays - 1));
    const dates = [];
    for (let i = 0; i < rangeDays; i++) dates.push(ymd(addDays(start, i)));

    const daily = dates.map(d => {
      const r = entries[d];
      const m = computeDay(r);
      return { date: d, raw: r || null, ...m };
    });

    const labels = daily.map(d => d.date.slice(5));
    const seData  = daily.map(d => d.se != null ? +d.se.toFixed(1) : null);
    const tstData = daily.map(d => d.tstMin != null ? +(d.tstMin / 60).toFixed(2) : null);
    const solData = daily.map(d => d.solMin != null ? d.solMin : null);
    const wasoData= daily.map(d => (d.raw && d.raw.waso != null && d.raw.waso !== '') ? parseFloat(d.raw.waso) : null);

    chartSE = upsertChart(chartSE, $('#chartSE'), {
      type: 'line',
      data: { labels, datasets: [{
        label: 'SE (%)', data: seData,
        borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,.12)',
        borderWidth: 2, tension: .3, fill: true, pointRadius: 4, spanGaps: true,
        pointBackgroundColor: ctx => {
          const v = ctx.raw; if (v == null) return '#9ca3af';
          if (v >= 85) return '#10b981'; if (v >= 75) return '#f59e0b'; return '#ef4444';
        },
      }]},
      options: lineOpts({ yMin: 0, yMax: 100, ySuffix: '%',
        targetLine: { value: 85, color: '#10b981', label: '目标 85%' } }),
    });

    chartTST = upsertChart(chartTST, $('#chartTST'), {
      type: 'line',
      data: { labels, datasets: [{
        label: 'TST (小时)', data: tstData,
        borderColor: '#7c3aed', backgroundColor: 'rgba(124,58,237,.12)',
        borderWidth: 2, tension: .3, fill: true, pointRadius: 3, spanGaps: true,
      }]},
      options: lineOpts({ yMin: 0, ySuffix: 'h' }),
    });

    chartSolWaso = upsertChart(chartSolWaso, $('#chartSolWaso'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'SOL (分)',  data: solData,  borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.1)', borderWidth: 2, tension: .3, fill: false, spanGaps: true, pointRadius: 3 },
        { label: 'WASO (分)', data: wasoData, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.1)', borderWidth: 2, tension: .3, fill: false, spanGaps: true, pointRadius: 3 },
      ]},
      options: lineOpts({ yMin: 0, ySuffix: '分' }),
    });

    const weekly = aggregateWeekly(daily);
    chartWeekly = upsertChart(chartWeekly, $('#chartWeekly'), {
      type: 'bar',
      data: { labels: weekly.labels, datasets: [
        { label: '平均 TST (小时)', data: weekly.tst, backgroundColor: 'rgba(79,70,229,.85)', borderRadius: 6, stack: 'sleep' },
        { label: '醒着的在床时间 (小时)', data: weekly.wakeInBed, backgroundColor: 'rgba(156,163,175,.55)', borderRadius: 6, stack: 'sleep' },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${ctx.raw != null ? ctx.raw.toFixed(2) + ' h' : '—'}`,
              footer: items => `合计 TIB: ${items.reduce((s, it) => s + (it.raw || 0), 0).toFixed(2)} h`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { stacked: true, beginAtZero: true, ticks: { callback: v => v + 'h', font: { size: 11 } } },
        },
      },
    });
  }

  function aggregateWeekly(daily) {
    const buckets = new Map();
    daily.forEach(d => {
      if (d.tibMin == null) return;
      const dt = parseYMD(d.date);
      const day = dt.getDay() || 7; // 周日按 7
      const monday = addDays(dt, -(day - 1));
      const key = ymd(monday);
      let b = buckets.get(key);
      if (!b) { b = { tibSum: 0, tstSum: 0, n: 0 }; buckets.set(key, b); }
      b.tibSum += d.tibMin;
      b.tstSum += (d.tstMin || 0);
      b.n += 1;
    });
    const sorted = Array.from(buckets.entries()).sort();
    const labels = sorted.map(([k], i) => `第${i+1}周\n${k.slice(5)}`);
    const tst = sorted.map(([, b]) => +(b.tstSum / b.n / 60).toFixed(2));
    const tib = sorted.map(([, b]) => +(b.tibSum / b.n / 60).toFixed(2));
    const wakeInBed = tib.map((t, i) => +(Math.max(0, t - tst[i])).toFixed(2));
    return { labels, tst, tib, wakeInBed };
  }

  function lineOpts({ yMin, yMax, ySuffix, targetLine } = {}) {
    const opts = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.raw != null ? ctx.raw + (ySuffix || '') : '—'}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 14 } },
        y: { beginAtZero: true, ticks: { callback: v => v + (ySuffix || ''), font: { size: 11 } } },
      },
    };
    if (yMin != null) opts.scales.y.min = yMin;
    if (yMax != null) opts.scales.y.max = yMax;
    if (targetLine) opts._targetLine = targetLine;
    return opts;
  }

  function upsertChart(chart, canvas, config) {
    if (chart) chart.destroy();
    const c = new Chart(canvas, config);
    const target = config.options && config.options._targetLine;
    if (target) {
      const plugin = {
        id: 'targetLine_' + Math.random().toString(36).slice(2),
        afterDatasetsDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          const y = scales.y.getPixelForValue(target.value);
          ctx.save();
          ctx.strokeStyle = target.color || '#10b981';
          ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
          ctx.fillStyle = target.color || '#10b981';
          ctx.font = '11px sans-serif';
          ctx.fillText(target.label || '', chartArea.right - 70, y - 4);
          ctx.restore();
        },
      };
      Chart.register(plugin);
    }
    return c;
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg, kind) {
    const el = $('#toast');
    el.className = 'toast show ' + (kind || '');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast ' + (kind || ''); }, 2200);
  }
})();
