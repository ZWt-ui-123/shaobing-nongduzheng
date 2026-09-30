/* ============================================================================
 * 哨兵 SepsisGuard —— 原生 Canvas 2D 图表库（charts.js）
 * ----------------------------------------------------------------------------
 * 全部图表使用原生 Canvas 2D API 手写绘制，不依赖任何第三方库：
 *   · sparkline  迷你风险趋势折线（患者卡片）
 *   · lineChart  折线图（支持多序列、缺失断线、竖线标记、半透明色带、悬浮十字线）
 *   · radar      雷达图（关键指标偏离度）
 *   · barChart   柱状 / 条形图（特征贡献、告警等级分布）
 *   · gantt      甘特 / 时间轴（监护时间轴）
 *   · riskBar    DOM 风险条
 * 兼容高 DPI 屏；窗口尺寸变化或容器尺寸变化时自动重绘。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 一、配色与常量
   * ------------------------------------------------------------------ */
  var PALETTE = {
    grid: 'rgba(148, 163, 184, 0.13)',
    axis: 'rgba(148, 163, 184, 0.38)',
    text: '#8ea3bf',
    textStrong: '#e2e8f0',
    accent: '#38bdf8',
    accent2: '#22d3ee',
    band: 'rgba(239, 68, 68, 0.13)',
    track: 'rgba(148, 163, 184, 0.16)'
  };

  // 风险等级配色（与 CSS 变量保持一致）
  var LEVEL_COLOR = { normal: '#64748b', low: '#22c55e', medium: '#f59e0b', high: '#ef4444' };

  // 多序列默认配色
  var SERIES_COLORS = ['#38bdf8', '#22d3ee', '#f59e0b', '#22c55e', '#a78bfa', '#f472b6', '#fb923c', '#e879f9'];

  var FONT = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  var FONT_SM = '10px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  var FONT_BOLD = '600 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

  /* ------------------------------------------------------------------ *
   * 二、通用工具
   * ------------------------------------------------------------------ */

  var registry = [];   // 已注册图表，用于尺寸变化时统一重绘

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function hexToRgba(hex, alpha) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var num = parseInt(h, 16);
    var r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  // 数字格式化：去掉多余小数位
  function fmtNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var a = Math.abs(v);
    var s;
    if (a >= 100) s = v.toFixed(0);
    else if (a >= 10) s = v.toFixed(1);
    else if (a >= 1) s = v.toFixed(2);
    else s = v.toFixed(2);
    return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  // 计算"好看"的坐标轴刻度
  function niceScale(min, max, ticks) {
    ticks = ticks || 5;
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (min === max) { min -= 0.5; max += 0.5; }
    var span = max - min;
    var raw = span / ticks;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    step *= mag;
    return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step: step };
  }

  // 高 DPI 画布准备：返回 CSS 像素尺寸与已缩放的上下文
  function hidpi(canvas) {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(24, Math.round(rect.width || canvas.clientWidth || canvas.width || 24));
    var h = Math.max(24, Math.round(rect.height || canvas.clientHeight || canvas.height || 24));
    var dpr = global.devicePixelRatio || 1;
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /* ------------------------------------------------------------------ *
   * 三、悬浮提示（HTML 层，便于中文排版）
   * ------------------------------------------------------------------ */

  function ensureTip(canvas) {
    var host = canvas.parentNode;
    if (!host) return null;
    if (!host.__sgtip) {
      if (global.getComputedStyle(host).position === 'static') host.style.position = 'relative';
      var tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.style.display = 'none';
      host.appendChild(tip);
      host.__sgtip = tip;
    }
    return host.__sgtip;
  }

  function showTip(canvas, html, px, py) {
    var tip = ensureTip(canvas);
    if (!tip) return;
    tip.innerHTML = html;
    tip.style.display = 'block';
    var host = canvas.parentNode;
    var hw = host.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = px + 14;
    if (left + tw > hw - 4) left = Math.max(4, px - tw - 14);
    var top = clamp(py - th / 2, 4, Math.max(4, host.clientHeight - th - 4));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip(canvas) {
    var host = canvas.parentNode;
    if (host && host.__sgtip) host.__sgtip.style.display = 'none';
  }

  /* ------------------------------------------------------------------ *
   * 四、注册与重绘
   * ------------------------------------------------------------------ */

  function register(canvas, type, cfg, draw) {
    for (var i = registry.length - 1; i >= 0; i--) {
      if (registry[i].canvas === canvas) registry.splice(i, 1);
    }
    // 顺带清理已被移出文档的画布（抽屉内容重建会替换 innerHTML），避免长期运行后注册表膨胀
    for (var j = registry.length - 1; j >= 0; j--) {
      var c = registry[j].canvas;
      if (c.isConnected === false) registry.splice(j, 1);
    }
    registry.push({ canvas: canvas, type: type, cfg: cfg, draw: draw });
    if (global.ResizeObserver && !canvas.__sgObserved) {
      canvas.__sgObserved = true;
      var ro = new global.ResizeObserver(function () { redrawOne(canvas); });
      ro.observe(canvas);
    }
  }

  function redrawOne(canvas) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].canvas === canvas) {
        if (!document.body.contains(canvas)) { registry.splice(i, 1); return; }
        registry[i].draw(canvas, registry[i].cfg);
        return;
      }
    }
  }

  function redrawAll() {
    registry.slice().forEach(function (r) {
      if (document.body.contains(r.canvas)) r.draw(r.canvas, r.cfg);
    });
  }

  var resizeTimer = null;
  global.addEventListener('resize', function () {
    if (resizeTimer) global.clearTimeout(resizeTimer);
    resizeTimer = global.setTimeout(redrawAll, 140);
  });

  function destroy(canvas) {
    for (var i = registry.length - 1; i >= 0; i--) {
      if (registry[i].canvas === canvas) registry.splice(i, 1);
    }
    hideTip(canvas);
  }

  /* ------------------------------------------------------------------ *
   * 五、迷你趋势折线（患者卡片）
   * ------------------------------------------------------------------ */

  function sparkline(canvas, values, opts) {
    opts = opts || {};
    var color = opts.color || PALETTE.accent;
    var draw = function (cv, o) {
      var g = hidpi(cv);
      var ctx = g.ctx, w = g.w, h = g.h;
      var vals = o.values || [];
      if (!vals.length) return;
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (hi - lo < 0.08) { var mid = (hi + lo) / 2; lo = mid - 0.04; hi = mid + 0.04; }
      var padY = 3;
      var n = vals.length;
      var xOf = function (i) { return n === 1 ? w / 2 : (i / (n - 1)) * (w - 1) + 0.5; };
      var yOf = function (v) { return h - padY - ((v - lo) / (hi - lo)) * (h - padY * 2); };

      // 面积
      if (o.fill !== false) {
        var grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, hexToRgba(color, 0.32));
        grad.addColorStop(1, hexToRgba(color, 0.02));
        ctx.beginPath();
        ctx.moveTo(xOf(0), h);
        for (var i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(vals[i]));
        ctx.lineTo(xOf(n - 1), h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      // 折线
      ctx.beginPath();
      for (var j = 0; j < n; j++) {
        if (j === 0) ctx.moveTo(xOf(j), yOf(vals[j]));
        else ctx.lineTo(xOf(j), yOf(vals[j]));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.stroke();
      // 末端点
      ctx.beginPath();
      ctx.arc(xOf(n - 1), yOf(vals[n - 1]), 1.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    draw(canvas, { values: values, color: color, fill: opts.fill });
    register(canvas, 'spark', { values: values, color: color, fill: opts.fill }, draw);
  }

  /* ------------------------------------------------------------------ *
   * 六、折线图（核心）
   * ------------------------------------------------------------------ */

  function lineChart(canvas, cfg) {
    var conf = Object.assign({
      hours: [], series: [], yMin: null, yMax: null, yLabel: '', xLabel: '小时',
      vlines: [], bands: [], markers: [], normalize: false, fill: false,
      yTicks: 5, xTickCount: 8, valueUnit: '', hover: null
    }, cfg || {});
    canvas.__sgcfg = conf;
    canvas.__sgtype = 'line';
    drawLine(canvas, conf);
    bindLineEvents(canvas);
    register(canvas, 'line', conf, drawLine);
  }

  function seriesValueAt(s, i) {
    var arr = s.values || [];
    var v = arr[i];
    return (v === null || v === undefined || !isFinite(v)) ? null : v;
  }

  // 归一化：映射到参考区间百分比（0% = 参考下限，100% = 参考上限）
  function normalizedValue(s, v) {
    var r = s.range || [0, 1];
    var span = (r[1] - r[0]) || 1;
    return ((v - r[0]) / span) * 100;
  }

  function drawLine(canvas, cfg) {
    var g = hidpi(canvas);
    var ctx = g.ctx, W = g.w, H = g.h;
    var hours = cfg.hours || [];
    var n = hours.length;

    var padL = 52, padR = (cfg.y2 ? 52 : 16), padT = 20, padB = 32;
    var plotW = Math.max(10, W - padL - padR);
    var plotH = Math.max(10, H - padT - padB);

    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    if (!n || !cfg.series.length) {
      ctx.fillStyle = PALETTE.text;
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', W / 2, H / 2);
      return;
    }

    var xOf = function (i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };

    // ---- 计算 Y 轴范围 ----
    var lo = Infinity, hi = -Infinity;
    cfg.series.forEach(function (s) {
      (s.values || []).forEach(function (v) {
        if (v === null || v === undefined || !isFinite(v)) return;
        var t = cfg.normalize ? normalizedValue(s, v) : v;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (cfg.normalize) {
      lo = Math.min(lo, 0); hi = Math.max(hi, 100);
      lo = Math.floor((lo - 8) / 10) * 10; hi = Math.ceil((hi + 8) / 10) * 10;
    }
    var scale = niceScale(
      cfg.yMin !== null && cfg.yMin !== undefined ? cfg.yMin : lo,
      cfg.yMax !== null && cfg.yMax !== undefined ? cfg.yMax : hi,
      cfg.yTicks
    );
    var yMin = scale.min, yMax = scale.max;
    if (cfg.yMin !== null && cfg.yMin !== undefined) yMin = cfg.yMin;
    if (cfg.yMax !== null && cfg.yMax !== undefined) yMax = cfg.yMax;
    var yOf = function (v) { return padT + plotH - ((v - yMin) / ((yMax - yMin) || 1)) * plotH; };

    // 记录布局，供悬浮交互换算使用
    canvas.__sgLayout = { padL: padL, padT: padT, plotW: plotW, plotH: plotH, n: n };

    // ---- 半透明色带（如脓毒症发作时刻） ----
    (cfg.bands || []).forEach(function (b) {
      var i0 = indexOfHour(hours, b.from);
      var i1 = indexOfHour(hours, b.to);
      if (i0 === null) return;
      if (i1 === null) i1 = n - 1;
      var x0 = xOf(i0), x1 = xOf(i1);
      ctx.fillStyle = b.color || PALETTE.band;
      ctx.fillRect(x0, padT, Math.max(2, x1 - x0), plotH);
      if (b.label) {
        ctx.save();
        ctx.font = FONT_SM;
        ctx.fillStyle = b.labelColor || '#fca5a5';
        ctx.textAlign = 'left';
        ctx.fillText(b.label, Math.min(x0 + 4, W - padR - 74), padT + 9);
        ctx.restore();
      }
    });

    // ---- 网格与 Y 轴刻度 ----
    ctx.textAlign = 'right';
    for (var v = yMin; v <= yMax + 1e-6; v += scale.step) {
      var y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
      ctx.strokeStyle = PALETTE.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = PALETTE.text;
      ctx.font = FONT_SM;
      var label = cfg.normalize ? (Math.round(v) + '%') : fmtNum(v);
      ctx.fillText(label, padL - 6, y);
    }

    // ---- X 轴刻度 ----
    var stepI = Math.max(1, Math.ceil(n / (cfg.xTickCount || 8)));
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.text;
    ctx.font = FONT_SM;
    for (var i = 0; i < n; i += stepI) {
      var x = xOf(i);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padT + plotH);
      ctx.lineTo(Math.round(x) + 0.5, padT + plotH + 4);
      ctx.strokeStyle = PALETTE.axis;
      ctx.stroke();
      ctx.fillText(String(hours[i]), x, padT + plotH + 14);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = PALETTE.text;
    ctx.font = FONT_SM;
    ctx.fillText(cfg.xLabel || '小时', padL + plotW / 2 - 12, H - 5);

    // ---- 数据序列（缺失处断开） ----
    cfg.series.forEach(function (s) {
      var pts = [];
      for (var k = 0; k < n; k++) {
        var raw = seriesValueAt(s, k);
        if (raw === null) { pts.push(null); continue; }
        pts.push(cfg.normalize ? normalizedValue(s, raw) : raw);
      }
      // 单序列面积填充
      if (cfg.fill && cfg.series.length === 1) {
        var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, hexToRgba(s.color, 0.26));
        grad.addColorStop(1, hexToRgba(s.color, 0.01));
        var seg = null;
        for (var a = 0; a <= n; a++) {
          var val = a < n ? pts[a] : null;
          if (val !== null) { if (!seg) seg = []; seg.push(a); }
          else if (seg) { fillSegment(ctx, seg, pts, xOf, yOf, padT, plotH, grad); seg = null; }
        }
      }
      // 折线：缺失处断开，绝不跨 null 连线
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      var pen = false;
      for (var m = 0; m < n; m++) {
        var pv = pts[m];
        if (pv === null) { pen = false; continue; }
        var px = xOf(m), py = yOf(pv);
        if (!pen) { ctx.moveTo(px, py); pen = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // 数据点
      if (s.points) {
        for (var q = 0; q < n; q++) {
          if (pts[q] === null) continue;
          ctx.beginPath();
          ctx.arc(xOf(q), yOf(pts[q]), 2, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.fill();
        }
      }
    });

    // ---- 竖线标记（告警触发点） ----
    (cfg.vlines || []).forEach(function (vl, idx) {
      var i = indexOfHour(hours, vl.x);
      if (i === null) return;
      var x = xOf(i);
      ctx.save();
      ctx.setLineDash(vl.dash || [4, 3]);
      ctx.strokeStyle = vl.color || LEVEL_COLOR.high;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padT);
      ctx.lineTo(Math.round(x) + 0.5, padT + plotH);
      ctx.stroke();
      ctx.restore();
      // 顶部三角标记
      ctx.beginPath();
      ctx.moveTo(x, padT - 1);
      ctx.lineTo(x - 4, padT - 8);
      ctx.lineTo(x + 4, padT - 8);
      ctx.closePath();
      ctx.fillStyle = vl.color || LEVEL_COLOR.high;
      ctx.fill();
      if (vl.label) {
        ctx.save();
        ctx.font = FONT_SM;
        ctx.fillStyle = vl.color || LEVEL_COLOR.high;
        ctx.textAlign = 'center';
        var lx = clamp(x, padL + 16, padL + plotW - 16);
        ctx.fillText(vl.label, lx, padT - 14 - (idx % 2) * 11);
        ctx.restore();
      }
    });

    // ---- 数据点标记（发作时刻等） ----
    (cfg.markers || []).forEach(function (mk) {
      var i = indexOfHour(hours, mk.x);
      if (i === null) return;
      ctx.beginPath();
      ctx.arc(xOf(i), yOf(mk.y), 3.4, 0, Math.PI * 2);
      ctx.fillStyle = mk.color || PALETTE.accent2;
      ctx.fill();
      ctx.strokeStyle = '#0b1220';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });

    // ---- 坐标轴边框 ----
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT);
    ctx.lineTo(padL + 0.5, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.strokeStyle = PALETTE.axis;
    ctx.lineWidth = 1;
    ctx.stroke();

    // ---- Y 轴标题 ----
    if (cfg.yLabel) {
      ctx.save();
      ctx.translate(11, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = PALETTE.text;
      ctx.font = FONT_SM;
      ctx.fillText(cfg.yLabel, 0, 0);
      ctx.restore();
    }

    // ---- 悬浮十字线 ----
    if (cfg.hover !== null && cfg.hover !== undefined && cfg.hover >= 0 && cfg.hover < n) {
      var hx = xOf(cfg.hover);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(226,232,240,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.restore();
      cfg.series.forEach(function (s) {
        var raw = seriesValueAt(s, cfg.hover);
        if (raw === null) return;
        var t = cfg.normalize ? normalizedValue(s, raw) : raw;
        ctx.beginPath();
        ctx.arc(hx, yOf(t), 3.6, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = '#0b1220';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });
    }
  }

  function fillSegment(ctx, seg, pts, xOf, yOf, padT, plotH, grad) {
    ctx.beginPath();
    ctx.moveTo(xOf(seg[0]), padT + plotH);
    seg.forEach(function (i) { ctx.lineTo(xOf(i), yOf(pts[i])); });
    ctx.lineTo(xOf(seg[seg.length - 1]), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  function indexOfHour(hours, h) {
    for (var i = 0; i < hours.length; i++) if (hours[i] === h) return i;
    return null;
  }

  function bindLineEvents(canvas) {
    if (canvas.__sgBound) return;
    canvas.__sgBound = true;

    canvas.addEventListener('mousemove', function (ev) {
      var cfg = canvas.__sgcfg;
      var layout = canvas.__sgLayout;
      if (!cfg || !layout || !layout.n) return;
      var rect = canvas.getBoundingClientRect();
      var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      var ratio = (px - layout.padL) / (layout.plotW || 1);
      var idx = Math.round(clamp(ratio, 0, 1) * (layout.n - 1));
      if (cfg.hover !== idx) { cfg.hover = idx; drawLine(canvas, cfg); }
      showTip(canvas, lineTipHtml(cfg, idx), px, py);
    });

    canvas.addEventListener('mouseleave', function () {
      var cfg = canvas.__sgcfg;
      if (!cfg) return;
      cfg.hover = null;
      hideTip(canvas);
      drawLine(canvas, cfg);
    });
  }

  function lineTipHtml(cfg, idx) {
    var hours = cfg.hours || [];
    var rows = '<div class="tip-title">第 ' + hours[idx] + ' 小时</div>';
    cfg.series.forEach(function (s) {
      var v = seriesValueAt(s, idx);
      var txt = v === null ? '未测量' : (fmtNum(v) + (s.unit ? ' ' + s.unit : ''));
      rows += '<div class="tip-row">' +
        '<span class="tip-dot" style="background:' + s.color + '"></span>' +
        '<span class="tip-name">' + s.name + '</span>' +
        '<span class="tip-val' + (v === null ? ' is-null' : '') + '">' + txt + '</span></div>';
    });
    if (cfg.normalize) rows += '<div class="tip-note">多指标叠加已按各自参考区间归一化</div>';
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * 七、雷达图（关键指标偏离度）
   * ------------------------------------------------------------------ */

  function radar(canvas, cfg) {
    var conf = Object.assign({ axes: [], color: PALETTE.accent, max: 1, rings: 4 }, cfg || {});
    var draw = function (cv, c) {
      var g = hidpi(cv);
      var ctx = g.ctx, W = g.w, H = g.h;
      var axes = c.axes || [];
      if (!axes.length) return;

      var cx = W / 2, cy = H / 2 + 2;
      var R = Math.max(18, Math.min(W, H) / 2 - 30);
      var N = axes.length;
      var angleOf = function (i) { return -Math.PI / 2 + (i / N) * Math.PI * 2; };
      var ptOf = function (i, r) { var a = angleOf(i); return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };

      // 同心网格
      ctx.strokeStyle = PALETTE.grid;
      ctx.lineWidth = 1;
      for (var r = 1; r <= c.rings; r++) {
        var rr = R * (r / c.rings);
        ctx.beginPath();
        for (var i = 0; i < N; i++) {
          var p = ptOf(i, rr);
          if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
        ctx.stroke();
      }
      // 轴线
      ctx.strokeStyle = PALETTE.grid;
      for (var k = 0; k < N; k++) {
        var e = ptOf(k, R);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(e[0], e[1]);
        ctx.stroke();
      }

      // 数据多边形
      ctx.beginPath();
      axes.forEach(function (ax, i) {
        var v = clamp(ax.value / c.max, 0, 1);
        var p = ptOf(i, R * (0.06 + v * 0.94));
        if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      });
      ctx.closePath();
      ctx.fillStyle = hexToRgba(c.color, 0.22);
      ctx.fill();
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // 顶点
      axes.forEach(function (ax, i) {
        var v = clamp(ax.value / c.max, 0, 1);
        var p = ptOf(i, R * (0.06 + v * 0.94));
        ctx.beginPath();
        ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2);
        ctx.fillStyle = c.color;
        ctx.fill();
      });

      // 标签
      ctx.font = FONT_SM;
      ctx.fillStyle = PALETTE.text;
      axes.forEach(function (ax, i) {
        var a = angleOf(i);
        var lx = cx + Math.cos(a) * (R + 16);
        var ly = cy + Math.sin(a) * (R + 13);
        ctx.textAlign = Math.abs(Math.cos(a)) < 0.25 ? 'center' : (Math.cos(a) > 0 ? 'left' : 'right');
        ctx.textBaseline = 'middle';
        ctx.fillStyle = ax.hot ? '#fca5a5' : PALETTE.text;
        ctx.fillText(ax.label, lx, ly);
      });

      // 中心刻度提示
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = PALETTE.text;
      ctx.font = FONT_SM;
      ctx.fillText('中心=正常，外圈=显著偏离', 6, H - 8);
    };
    draw(canvas, conf);
    register(canvas, 'radar', conf, draw);
  }

  /* ------------------------------------------------------------------ *
   * 八、柱状 / 条形图
   * ------------------------------------------------------------------ */

  // cfg: { bars:[{label, value, color, note}], horizontal, max, valueFmt, axisLabel }
  function barChart(canvas, cfg) {
    var conf = Object.assign({ bars: [], horizontal: false, max: null, valueFmt: null, axisLabel: '' }, cfg || {});
    var draw = function (cv, c) {
      var g = hidpi(cv);
      var ctx = g.ctx, W = g.w, H = g.h;
      var bars = c.bars || [];
      if (!bars.length) {
        ctx.font = FONT;
        ctx.fillStyle = PALETTE.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('暂无数据', W / 2, H / 2);
        return;
      }
      var fmt = c.valueFmt || fmtNum;

      if (c.horizontal) {
        var labelW = c.labelWidth || 96;
        var valueW = 54;
        var padT = 6, padB = 18;
        var rowH = Math.max(16, (H - padT - padB) / bars.length);
        var barH = Math.min(16, rowH * 0.56);
        var maxV = c.max || Math.max.apply(null, bars.map(function (b) { return Math.abs(b.value); })) || 1;
        var trackX = labelW, trackW = Math.max(20, W - labelW - valueW);

        // 中轴线（方向区分：向左=下降，向右=上升）
        var zeroX = c.diverging ? trackX + trackW * 0.42 : trackX;
        if (c.diverging) {
          ctx.beginPath();
          ctx.moveTo(Math.round(zeroX) + 0.5, padT);
          ctx.lineTo(Math.round(zeroX) + 0.5, padT + rowH * bars.length);
          ctx.strokeStyle = PALETTE.axis;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        bars.forEach(function (b, i) {
          var cy = padT + rowH * i + rowH / 2;
          var v = b.value;
          var wpx = (Math.abs(v) / maxV) * (c.diverging ? (v >= 0 ? (trackX + trackW - zeroX) : (zeroX - trackX)) : trackW);
          var x0 = c.diverging ? (v >= 0 ? zeroX : zeroX - wpx) : trackX;
          // 轨道
          ctx.fillStyle = PALETTE.track;
          roundRect(ctx, trackX, cy - barH / 2, trackW, barH, 3);
          ctx.fill();
          // 数值条
          var color = b.color || PALETTE.accent;
          var grad = ctx.createLinearGradient(x0, 0, x0 + (v >= 0 ? wpx : -wpx) || x0 + 1, 0);
          grad.addColorStop(0, hexToRgba(color, 0.55));
          grad.addColorStop(1, color);
          ctx.fillStyle = grad;
          roundRect(ctx, x0, cy - barH / 2, Math.max(2, wpx), barH, 3);
          ctx.fill();
          // 标签
          ctx.font = FONT_SM;
          ctx.fillStyle = PALETTE.textStrong;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(b.label, labelW - 8, cy);
          // 数值
          ctx.textAlign = 'left';
          ctx.fillStyle = color;
          ctx.font = FONT_BOLD;
          ctx.fillText(fmt(v) + (b.suffix || ''), trackX + trackW + 6, cy);
        });
      } else {
        var padL = 34, padR = 8, padT = 16, padB = 26;
        var plotW2 = Math.max(10, W - padL - padR);
        var plotH2 = Math.max(10, H - padT - padB);
        var maxV2 = c.max || Math.max.apply(null, bars.map(function (b) { return b.value; })) || 1;
        var sc = niceScale(0, maxV2, 3);
        var yOf = function (v) { return padT + plotH2 - (v / (sc.max || 1)) * plotH2; };
        // 网格
        ctx.font = FONT_SM;
        for (var v2 = 0; v2 <= sc.max + 1e-6; v2 += sc.step) {
          var y = yOf(v2);
          ctx.beginPath();
          ctx.moveTo(padL, Math.round(y) + 0.5);
          ctx.lineTo(padL + plotW2, Math.round(y) + 0.5);
          ctx.strokeStyle = PALETTE.grid;
          ctx.stroke();
          ctx.fillStyle = PALETTE.text;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(fmtNum(v2), padL - 5, y);
        }
        var slot = plotW2 / bars.length;
        var bw = Math.min(46, slot * 0.5);
        bars.forEach(function (b, i) {
          var cx2 = padL + slot * i + slot / 2;
          var hgt = Math.max(1, (b.value / (sc.max || 1)) * plotH2);
          var color2 = b.color || PALETTE.accent;
          var gr = ctx.createLinearGradient(0, yOf(b.value), 0, padT + plotH2);
          gr.addColorStop(0, color2);
          gr.addColorStop(1, hexToRgba(color2, 0.25));
          ctx.fillStyle = gr;
          roundRect(ctx, cx2 - bw / 2, yOf(b.value), bw, hgt, 3);
          ctx.fill();
          ctx.fillStyle = PALETTE.textStrong;
          ctx.font = FONT_BOLD;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(fmt(b.value), cx2, yOf(b.value) - 3);
          ctx.fillStyle = PALETTE.text;
          ctx.font = FONT_SM;
          ctx.textBaseline = 'top';
          ctx.fillText(b.label, cx2, padT + plotH2 + 6);
        });
        if (c.axisLabel) {
          ctx.fillStyle = PALETTE.text;
          ctx.font = FONT_SM;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(c.axisLabel, 4, 2);
        }
      }
    };
    draw(canvas, conf);
    register(canvas, 'bar', conf, draw);
  }

  /* ------------------------------------------------------------------ *
   * 九、甘特 / 时间轴
   * cfg: { rows:[{label, from, to, color, marks:[{at,color}], text, dim}], xMax, xLabel }
   * ------------------------------------------------------------------ */

  function gantt(canvas, cfg) {
    var conf = Object.assign({ rows: [], xMax: null, xLabel: '入 ICU 后小时' }, cfg || {});
    var draw = function (cv, c) {
      var g = hidpi(cv);
      var ctx = g.ctx, W = g.w, H = g.h;
      var rows = c.rows || [];
      if (!rows.length) {
        ctx.font = FONT;
        ctx.fillStyle = PALETTE.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('暂无数据', W / 2, H / 2);
        return;
      }
      var labelW = 108, rightW = 62, padT = 22, padB = 22;
      var plotW = Math.max(20, W - labelW - rightW);
      var rowH = Math.max(13, (H - padT - padB) / rows.length);
      var barH = Math.min(11, rowH * 0.5);
      var xMax = c.xMax || Math.max.apply(null, rows.map(function (r) { return r.to; })) || 1;
      var xOf = function (h) { return labelW + (h / xMax) * plotW; };

      // X 轴刻度（取 ~8 个刻度，保证时间轴可读性）
      var sc = niceScale(0, xMax, 8);
      ctx.font = FONT_SM;
      ctx.textBaseline = 'middle';
      for (var t = 0; t <= sc.max + 1e-6; t += sc.step) {
        var x = xOf(t);
        if (x > labelW + plotW + 1) break;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, padT - 6);
        ctx.lineTo(Math.round(x) + 0.5, padT + rowH * rows.length);
        ctx.strokeStyle = PALETTE.grid;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = PALETTE.text;
        ctx.textAlign = 'center';
        ctx.fillText(fmtNum(t) + 'h', x, padT - 12);
      }

      rows.forEach(function (r, i) {
        var cy = padT + rowH * i + rowH / 2;
        // 行标签
        ctx.font = FONT_SM;
        ctx.fillStyle = r.dim ? 'rgba(142,163,191,0.6)' : PALETTE.textStrong;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.label, labelW - 8, cy);
        // 轨道
        ctx.fillStyle = PALETTE.track;
        roundRect(ctx, labelW, cy - barH / 2, plotW, barH, barH / 2);
        ctx.fill();
        // 监护条
        var x0 = xOf(r.from || 0), x1 = xOf(r.to);
        var color = r.color || PALETTE.accent;
        var grad = ctx.createLinearGradient(x0, 0, x1, 0);
        grad.addColorStop(0, hexToRgba(color, 0.5));
        grad.addColorStop(1, color);
        ctx.fillStyle = grad;
        roundRect(ctx, x0, cy - barH / 2, Math.max(3, x1 - x0), barH, barH / 2);
        ctx.fill();
        // 事件标记
        (r.marks || []).forEach(function (mk) {
          var mx = xOf(mk.at);
          ctx.beginPath();
          ctx.arc(mx, cy, 3, 0, Math.PI * 2);
          ctx.fillStyle = mk.color || LEVEL_COLOR.high;
          ctx.fill();
          ctx.strokeStyle = '#0b1220';
          ctx.lineWidth = 1;
          ctx.stroke();
        });
        // 右侧说明
        if (r.text) {
          ctx.textAlign = 'left';
          ctx.font = FONT_SM;
          ctx.fillStyle = PALETTE.text;
          ctx.fillText(r.text, labelW + plotW + 6, cy);
        }
      });

      ctx.fillStyle = PALETTE.text;
      ctx.font = FONT_SM;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(c.xLabel, W - 4, H - 4);
    };
    draw(canvas, conf);
    register(canvas, 'gantt', conf, draw);
  }

  /* ------------------------------------------------------------------ *
   * 十、DOM 风险条
   * ------------------------------------------------------------------ */

  function riskBar(host, score, level, opts) {
    if (!host) return;
    opts = opts || {};
    var color = LEVEL_COLOR[level] || PALETTE.accent;
    var pct = Math.round(clamp(score, 0, 1) * 100);
    host.innerHTML = '';
    host.classList.add('riskbar');

    var head = document.createElement('div');
    head.className = 'riskbar-head';
    var t1 = document.createElement('span');
    t1.className = 'riskbar-label';
    t1.textContent = opts.label || '风险分数';
    var t2 = document.createElement('span');
    t2.className = 'riskbar-value';
    t2.style.color = color;
    t2.textContent = score.toFixed(2);
    head.appendChild(t1);
    head.appendChild(t2);

    var track = document.createElement('div');
    track.className = 'riskbar-track';
    var fill = document.createElement('div');
    fill.className = 'riskbar-fill';
    fill.style.width = pct + '%';
    fill.style.background = 'linear-gradient(90deg,' + hexToRgba(color, 0.45) + ',' + color + ')';
    track.appendChild(fill);

    var foot = document.createElement('div');
    foot.className = 'riskbar-foot';
    foot.innerHTML = '<span>低</span><span class="riskbar-thr">0.40 中</span><span class="riskbar-thr">0.65 高</span><span>1.00</span>';

    host.appendChild(head);
    host.appendChild(track);
    host.appendChild(foot);
  }

  /* ------------------------------------------------------------------ *
   * 十一、业务辅助：参考区间偏离度
   * ------------------------------------------------------------------ */

  // 返回 0~1 的偏离度：0 = 位于参考区间中心，1 = 显著超出参考区间
  function deviation(value, lo, hi) {
    if (value === null || value === undefined || !isFinite(value)) return 0;
    var span = (hi - lo) || 1;
    if (value >= lo && value <= hi) {
      // 区间内：按离中心距离给出 0~0.25 的低偏离度
      var mid = (lo + hi) / 2;
      return 0.25 * (Math.abs(value - mid) / (span / 2));
    }
    var over = value > hi ? (value - hi) / span : (lo - value) / span;
    return clamp(0.35 + over * 0.65, 0, 1);
  }

  function clear(canvas) {
    var g = hidpi(canvas);
    g.ctx.clearRect(0, 0, g.w, g.h);
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  global.SGCharts = {
    PALETTE: PALETTE,
    LEVEL_COLOR: LEVEL_COLOR,
    SERIES_COLORS: SERIES_COLORS,
    hexToRgba: hexToRgba,
    fmtNum: fmtNum,
    clamp: clamp,
    deviation: deviation,
    sparkline: sparkline,
    lineChart: lineChart,
    radar: radar,
    barChart: barChart,
    gantt: gantt,
    riskBar: riskBar,
    redrawAll: redrawAll,
    destroy: destroy,
    clear: clear
  };
})(window);
