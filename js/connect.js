/* ============================================================================
 * 哨兵 SepsisGuard —— 数据接入页脚本（connect.js）
 * ----------------------------------------------------------------------------
 * 本页是**真实后端连接的入口**。它与其它页面的关键区别：
 *   本页所有请求都不使用演示数据兜底。连接失败必须原样呈现失败原因，
 *   否则使用者无法分清"我接的是真实数据"还是"我看的是演示数据"。
 *
 * 六条数据通路：
 *   file     文件导入（CSV / JSONL）
 *   rest     自定义 REST / JSON 接口
 *   fhir     FHIR R4（医院信息系统标准接口）
 *   webhook  推送接收（设备网关 / 护理终端 / 可穿戴平台）
 *   live     动态监护后端（连续仿真，见 live.html）
 *   manual   手动录入（见 manual.html）
 * ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = String(global.SEPSISGUARD_API || '').replace(/\/+$/, '');

  /* ------------------------------------------------------------------ *
   * DOM 助手
   * ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function fmtNum(value, digits) {
    if (value === null || value === undefined || value === '') return '—';
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return num.toFixed(digits === undefined ? 0 : digits);
  }

  function fmtPct(value, digits) {
    if (value === null || value === undefined) return '—';
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return (num * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  function nowClock() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ------------------------------------------------------------------ *
   * HTTP（失败即失败，不兜底）
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   * 数据访问：全部经 SGBridge
   * ------------------------------------------------------------------
   * 本页是**真实系统对接**的入口（文件 / REST / FHIR / HL7 / 推送），
   * 这一类功能确实需要一个服务进程去读写文件与发起网络连接，浏览器沙箱
   * 做不到。因此这一页是全部页面中**唯一**在后端不可用时会明确提示
   * "需要启动后端服务"的地方——这不是缺陷，而是这类功能的固有前提。
   *
   * 与之相对，「动态监护」「手动录入」「报告中心」「观察日志」四条通路
   * 走的是我们自己的仿真数据，已内置在浏览器里，不需要后端。
   * ------------------------------------------------------------------ */
  function request(path, options) {
    return global.SGBridge.route(path, options);
  }

  /* ------------------------------------------------------------------ *
   * 通路图标（纯文本，避免引入图标字体依赖）
   * ------------------------------------------------------------------ */
  var PATH_ICON = {
    file: '▤', rest: '⇄', fhir: '✚',
    webhook: '⇉', live: '◉', manual: '✎'
  };

  var PATH_HINT = {
    file: '适合回顾性分析、科研与护理记录表导入；导入后可直接做批量评分。',
    rest: '需要服务端提供 GET <基地址>/observations 接口；返回 JSON 中的观测数组。',
    fhir: '医院若已部署 FHIR R4 服务，填写基地址即可，无需自建接口。',
    webhook: '由外部系统主动 POST 数据，本平台被动接收；适合设备网关与可穿戴平台。',
    live: '没有真实后端时使用；数据随时间连续变化，可推进、暂停、快进。',
    manual: '逐项填写少量患者指标；滑条已限定在生理可能范围内，避免录入离谱数值。'
  };

  /* ------------------------------------------------------------------ *
   * 页面状态
   * ------------------------------------------------------------------ */
  var store = {
    paths: [],
    selected: null,
    scenarios: [],
    probeHistory: [],
    lastResult: null
  };

  /* ------------------------------------------------------------------ *
   * 顶部连接状态与汇总
   * ------------------------------------------------------------------ */
  function setConn(mode, text) {
    var box = $('connBox');
    if (!box) return;
    box.classList.remove('is-online', 'is-offline', 'is-error');
    if (mode) box.classList.add('is-' + mode);
    $('connText').textContent = text;
  }

  function applyState(state) {
    if (!state) return;
    var label = state.active_source || '未接入';
    $('tkPatients').textContent = fmtNum(state.patients_cached);
    $('tkObs').textContent = fmtNum(state.observations_cached);
    $('heroFactActive').textContent = label;
    $('heroFactFetches').textContent = fmtNum(state.fetch_count);
    $('navActive').textContent = '当前数据源：' + label;
  }

  function setHero(sentence, note) {
    $('heroSentence').innerHTML = sentence;
    $('heroNote').textContent = note || '';
  }

  /* ------------------------------------------------------------------ *
   * 通路卡片
   * ------------------------------------------------------------------ */
  function renderPaths() {
    var grid = clear($('pathGrid'));
    store.paths.forEach(function (path) {
      var card = el('div', 'path-card');
      if (store.selected === path.key) card.classList.add('is-selected');
      card.dataset.key = path.key;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');

      var head = el('div', 'path-head');
      head.appendChild(el('span', 'path-icon', PATH_ICON[path.key] || '●'));
      head.appendChild(el('span', 'path-name', path.name_zh));
      card.appendChild(head);
      card.appendChild(el('div', 'path-desc', path.description));

      var meta = el('div', 'path-meta');
      if (path.fields && path.fields.length) {
        meta.textContent = '需配置 ' + path.fields.length + ' 项';
      } else if (path.endpoint) {
        meta.textContent = path.endpoint;
      } else {
        meta.textContent = '无需配置';
      }
      card.appendChild(meta);

      function pick() { selectPath(path.key); }
      card.addEventListener('click', pick);
      card.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
      });
      grid.appendChild(card);
    });
  }

  /* ------------------------------------------------------------------ *
   * 配置表单
   * ------------------------------------------------------------------ */
  function selectPath(key) {
    store.selected = key;
    renderPaths();

    var path = null;
    for (var i = 0; i < store.paths.length; i++) {
      if (store.paths[i].key === key) { path = store.paths[i]; break; }
    }
    if (!path) return;

    var panel = $('configPanel');
    panel.style.display = '';
    $('configTitle').textContent = path.name_zh;
    $('configSub').textContent = PATH_HINT[key] || path.description;
    $('resultBox').style.display = 'none';

    var form = clear($('configForm'));

    if (!path.fields || !path.fields.length) {
      var tip = el('div', 'field');
      tip.style.gridColumn = '1 / -1';
      var msg = el('div', 'hint');
      if (key === 'webhook') {
        msg.innerHTML =
          '推送式接入无需出站连接：让外部系统把数据 POST 到本服务的 ' +
          '<code>POST /api/ingest/webhook</code> 即可，' +
          '支持标准、平铺与常见别名三种字段形式。';
      } else if (key === 'live') {
        msg.innerHTML =
          '动态监护后端由本平台内置生成，不需要外部地址。' +
          '请到 <a href="live.html" style="color:var(--accent-hi)">动态监护</a> 页启动与推进。';
      } else if (key === 'manual') {
        msg.innerHTML =
          '手动录入不需要连接配置。' +
          '请到 <a href="manual.html" style="color:var(--accent-hi)">手动录入</a> 页逐项填写指标。';
      } else {
        msg.textContent = '该通路不需要配置参数。';
      }
      tip.appendChild(msg);
      form.appendChild(tip);

      var row = el('div', 'field');
      row.style.gridColumn = '1 / -1';
      var btn = el('button', 'btn is-primary', '打开对应页面');
      btn.style.alignSelf = 'flex-start';
      btn.addEventListener('click', function () {
        if (key === 'live') location.href = 'live.html';
        else if (key === 'manual') location.href = 'manual.html';
        else if (key === 'webhook') showWebhookHelp();
      });
      row.appendChild(btn);
      form.appendChild(row);

      $('probeBtn').disabled = (key !== 'webhook');
      $('activateBtn').disabled = (key !== 'webhook');
      $('sampleBtn').disabled = true;
      probeBtnLabel(key);
      return;
    }

    $('probeBtn').disabled = false;
    $('activateBtn').disabled = false;
    $('sampleBtn').disabled = false;
    probeBtnLabel(key);

    path.fields.forEach(function (field) {
      var wrap = el('div', 'field');
      var label = el('label');
      label.textContent = field.label;
      if (field.required) label.appendChild(el('span', 'req', '*'));
      label.setAttribute('for', 'fld-' + field.name);
      wrap.appendChild(label);

      var input = document.createElement('input');
      input.type = (field.name === 'token') ? 'password' : 'text';
      input.id = 'fld-' + field.name;
      input.dataset.field = field.name;
      input.placeholder = field.placeholder || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      wrap.appendChild(input);

      if (field.name === 'token') {
        wrap.appendChild(el('div', 'hint',
          '凭据只保存在服务进程内存中，不落盘、不回显、不写入日志。'));
      }
      form.appendChild(wrap);
    });

    // 超时设置（所有出站连接通路都需要）
    if (key === 'file') {
      var fh = el('div', 'hint');
      fh.style.gridColumn = '1 / -1';
      fh.textContent =
        'CSV 需含表头，至少包含 patient_id、record_time 两列，其余列按指标名命名' +
        '（HR、O2Sat、SBP、Lactate 等；常见别名会自动映射）。';
      form.appendChild(fh);
    } else {
      var tw = el('div', 'field');
      var tl = el('label', null, '连接超时（秒）');
      tw.appendChild(tl);
      var ti = document.createElement('input');
      ti.type = 'number'; ti.id = 'fld-timeout_seconds';
      ti.dataset.field = 'timeout_seconds';
      ti.value = '10'; ti.min = '1'; ti.max = '120';
      tw.appendChild(ti);
      form.appendChild(tw);
    }
  }

  function probeBtnLabel(key) {
    if (key === 'webhook') {
      $('probeBtn').textContent = '① 查看推送端点状态';
      $('activateBtn').textContent = '② 切换为推送式接入';
    } else {
      $('probeBtn').textContent = '① 自检连通性';
      $('activateBtn').textContent = '② 接入并拉取数据';
    }
  }

  function collectConfig() {
    var config = {
      kind: store.selected,
      address: '',
      token: '',
      timeout_seconds: 10,
      label: ''
    };
    var inputs = $('configForm').querySelectorAll('[data-field]');
    for (var i = 0; i < inputs.length; i++) {
      var key = inputs[i].dataset.field;
      var value = inputs[i].value;
      if (key === 'timeout_seconds') {
        var t = parseFloat(value);
        config.timeout_seconds = isFinite(t) ? Math.min(120, Math.max(1, t)) : 10;
      } else {
        config[key] = value;
      }
    }
    return config;
  }

  /* ------------------------------------------------------------------ *
   * 结果展示
   * ------------------------------------------------------------------ */
  function showResult(kind, title, lines, extras) {
    var box = $('resultBox');
    box.style.display = '';
    box.className = 'result-box is-' + kind;
    clear(box);

    box.appendChild(el('div', 'rb-title', title));
    (lines || []).forEach(function (line) {
      box.appendChild(el('div', null, line));
    });

    if (extras && extras.detail) {
      var pre = document.createElement('pre');
      pre.textContent = JSON.stringify(extras.detail, null, 2);
      box.appendChild(pre);
    }
    if (extras && extras.hint) {
      box.appendChild(el('div', 'rb-hint', '排查建议：' + extras.hint));
    }
  }

  function busy(on, which) {
    ['probeBtn', 'activateBtn', 'sampleBtn'].forEach(function (id) {
      var node = $(id);
      if (!node) return;
      if (which && id !== which) return;
      node.disabled = on;
    });
  }

  /* ------------------------------------------------------------------ *
   * 动作：自检
   * ------------------------------------------------------------------ */
  function runProbe() {
    if (store.selected === 'webhook') return showWebhookHelp();
    var config = collectConfig();
    busy(true, 'probeBtn');
    showResult('info', '正在自检…', ['正在连接 ' + (config.address || '—') + '，请稍候。']);

    request('/api/sources/probe', { method: 'POST', body: config })
      .then(function (data) {
        busy(false, 'probeBtn');
        var ok = data && data.ok === true;
        var lines = [];
        if (data.source) lines.push('数据源：' + data.source);
        if (data.latency_ms !== undefined) lines.push('耗时：' + fmtNum(data.latency_ms, 1) + ' ms');
        if (data.message) lines.push('结果：' + data.message);
        if (data.error) lines.push('错误：' + data.error);
        if (data.detail) {
          var keys = Object.keys(data.detail);
          keys.slice(0, 8).forEach(function (k) {
            var v = data.detail[k];
            if (v === null || v === undefined || typeof v === 'object') return;
            lines.push('　· ' + k + ' = ' + v);
          });
        }
        showResult(ok ? 'ok' : 'fail',
          ok ? '自检通过：该数据源可以读取' : '自检未通过',
          lines, { detail: data.detail, hint: data.hint });
        loadProbeHistory();
      })
      .catch(function (err) {
        busy(false, 'probeBtn');
        showResult('fail', '自检请求本身失败（服务未响应）', [
          '错误：' + err.message,
          '这意味着接入服务进程没有运行，或本页面与服务不在同一地址。',
          '自检功能位于 ' + (API_BASE || '(同源)') + '，请确认服务已启动。'
        ], err.payload && err.payload.detail ? { detail: err.payload.detail } : null);
      });
  }

  function showWebhookHelp() {
    request('/api/ingest/webhook/stats')
      .then(function (data) {
        var lines = [
          '推送端点：POST /api/ingest/webhook',
          '　标准形式：{"patient_id": "P001", "record_time": "...", "values": {"HR": 92}}',
          '　平铺形式：{"patient_id": "P001", "HR": 92, "O2Sat": 96}',
          '　别名形式：{"patient_id": "P001", "heart_rate": 92, "spo2": 96}',
          '',
          '缓冲区当前：' + fmtNum(data.buffered) + ' 条，涉及 ' +
            fmtNum(data.patients_in_buffer) + ' 位患者；累计接收 ' + fmtNum(data.received_total) + ' 条。'
        ];
        if (data.by_patient && Object.keys(data.by_patient).length) {
          var parts = Object.keys(data.by_patient).slice(0, 8).map(function (pid) {
            return pid + '×' + data.by_patient[pid];
          });
          lines.push('按患者：' + parts.join('，'));
        }
        if (data.recent && data.recent.length) {
          var last = data.recent[data.recent.length - 1];
          lines.push('最近一条：' + last.patient_id + ' · ' +
            last.n_variables + ' 项指标 · ' + (last.variables || []).join(', '));
        }
        showResult('info', '推送式接入已就绪', lines);
      })
      .catch(function (err) {
        showResult('fail', '无法读取推送状态', ['错误：' + err.message]);
      });
  }

  /* ------------------------------------------------------------------ *
   * 动作：接入
   * ------------------------------------------------------------------ */
  function runActivate() {
    if (store.selected === 'webhook') {
      request('/api/sources/activate', {
        method: 'POST',
        body: { kind: 'webhook', address: '', token: '', timeout_seconds: 10, label: '' }
      }).then(function (data) {
        showResult('ok', '已切换为推送式接入', [data.message || '', '端点：' + (data.endpoint || '')]);
        refreshState();
      }).catch(function (err) {
        showResult('fail', '切换失败', ['错误：' + err.message]);
      });
      return;
    }

    var config = collectConfig();
    busy(true, 'activateBtn');
    showResult('info', '正在接入并拉取数据…', ['目标：' + (config.address || '—')]);

    request('/api/sources/activate', { method: 'POST', body: config })
      .then(function (data) {
        busy(false, 'activateBtn');
        if (!data || data.ok !== true) {
          showResult('fail', '接入失败', [
            '错误：' + (data && (data.error || data.detail)) || '未知错误',
            '说明：接入失败时本平台不会退回演示数据，以避免把演示结果误当成真实数据。'
          ], { hint: data && data.hint });
          return;
        }
        var lines = [data.message || ''];
        if (data.patients !== undefined) lines.push('患者数：' + fmtNum(data.patients));
        if (data.observations !== undefined) lines.push('观测记录：' + fmtNum(data.observations));
        if (data.variables && data.variables.length) {
          lines.push('识别到的指标（' + data.variables.length + ' 项）：' +
            data.variables.slice(0, 24).join('、') +
            (data.variables.length > 24 ? ' …' : ''));
        }
        showResult('ok', '接入成功，数据已进入评估管道', lines);
        applyState(data.state);
        refreshState();
      })
      .catch(function (err) {
        busy(false, 'activateBtn');
        showResult('fail', '接入请求失败', [
          '错误：' + err.message,
          '接入失败时本平台不会退回演示数据。'
        ], err.payload && err.payload.detail ? { detail: err.payload.detail } : null);
      });
  }

  /* ------------------------------------------------------------------ *
   * 动作：读取原始样本
   * ------------------------------------------------------------------ */
  function runSample() {
    if (!store.selected || store.selected === 'webhook') return;
    var config = collectConfig();
    busy(true, 'sampleBtn');
    showResult('info', '正在读取样本…', ['从 ' + (config.address || '—') + ' 读取前若干条原始记录。']);

    request('/api/sources/sample?kind=' + encodeURIComponent(config.kind) +
      '&address=' + encodeURIComponent(config.address) +
      '&limit=5' + (config.token ? '&token=' + encodeURIComponent(config.token) : ''))
      .then(function (data) {
        busy(false, 'sampleBtn');
        var lines = ['样本条数：' + fmtNum(data.count)];
        if (data.variables) lines.push('涉及指标：' + data.variables.join('、'));
        (data.samples || []).forEach(function (s, i) {
          lines.push((i + 1) + '. ' + s.patient_id + ' @ ' + s.record_time +
            '　' + JSON.stringify(s.values));
        });
        showResult(data.count ? 'ok' : 'info',
          data.count ? '已读到原始样本（前 ' + data.count + ' 条）' : '没有读到样本', lines);
      })
      .catch(function (err) {
        busy(false, 'sampleBtn');
        showResult('fail', '读取样本失败', ['错误：' + err.message]);
      });
  }

  /* ------------------------------------------------------------------ *
   * 场景表
   * ------------------------------------------------------------------ */
  function renderScenarios() {
    var body = clear($('scenarioBody'));
    store.scenarios.forEach(function (s) {
      var tr = document.createElement('tr');

      var tdName = el('td');
      tdName.appendChild(el('b', null, s.name_zh));
      tr.appendChild(tdName);

      tr.appendChild(el('td', 'num',
        s.vital_interval_hours ? s.vital_interval_hours + ' 小时' : '—'));
      tr.appendChild(el('td', 'num',
        s.lab_interval_hours ? s.lab_interval_hours + ' 小时' : '不采血'));
      tr.appendChild(el('td', 'num',
        (s.n_monitored_vitals + s.n_available_labs) + ' 项'));

      var tdBar = el('td');
      var pct = Math.max(0, Math.min(1, s.info_completeness));
      var level = pct >= 0.7 ? 'ok' : (pct >= 0.25 ? 'medium' : 'critical');
      var bar = el('div', 'meter');
      var fill = el('div', 'meter-fill is-' + level);
      fill.style.width = (pct * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      tdBar.appendChild(bar);
      tdBar.appendChild(el('span', 'faint', fmtPct(pct)));
      tr.appendChild(tdBar);

      var tdNote = el('td');
      var notes = [];
      notes.push(s.has_advanced_monitoring ? '有高级监测' : '无高级监测');
      notes.push('脓毒症发生率约 ' + fmtPct(s.sepsis_rate));
      notes.push('置信度折减 ' + s.confidence_discount);
      tdNote.appendChild(el('span', 'faint', notes.join('；')));
      tr.appendChild(tdNote);

      body.appendChild(tr);
    });
  }

  /* ------------------------------------------------------------------ *
   * 自检历史
   * ------------------------------------------------------------------ */
  function renderProbeHistory() {
    var wrap = clear($('probeHistory'));
    if (!store.probeHistory.length) {
      wrap.appendChild(el('p', 'dim', '尚无自检记录。点击上方任一通路并执行「自检连通性」后会在此留痕。'));
      return;
    }
    store.probeHistory.slice().reverse().forEach(function (row) {
      var line = el('div', 'history-row');
      line.appendChild(el('span', 'hr-time', row.at || '—'));
      line.appendChild(el('span', 'hr-kind', row.kind || '—'));
      var mark = el('span', row.ok ? 'num-neg' : 'num-pos', row.ok ? '通过' : '失败');
      line.appendChild(mark);
      line.appendChild(el('span', 'hr-msg',
        (row.message || '') + (row.address ? '（' + row.address + '）' : '')));
      wrap.appendChild(line);
    });
  }

  function loadProbeHistory() {
    return request('/api/sources/active').then(function (data) {
      store.probeHistory = (data && data.probe_history) || [];
      renderProbeHistory();
      if (data && data.state) applyState(data.state);
    }).catch(function () { /* 历史读取失败不影响主流程，但也不伪造内容 */ });
  }

  /* ------------------------------------------------------------------ *
   * 汇总状态
   * ------------------------------------------------------------------ */
  function refreshState() {
    return request('/api/sources').then(function (data) {
      // 内置仿真模式下这个接口会明确返回 needs_server，而不是假装有一份通路目录。
      // 必须在这里就走"需要后端"的分支，否则界面会显示一个空洞的通路列表——
      // 使用者看到的是"页面坏了"，而不是"这里需要启动服务"。
      if (data && data.needs_server) {
        setConn('error', '需要后端服务');
        renderBackendRequired(new Error(data.note || '当前为浏览器内置仿真模式'));
        return data;
      }
      store.paths = (data && data.paths) || [];
      if (store.paths.length && !store.selected) {
        store.selected = (data.state && data.state.active_key) || store.paths[0].key;
      }
      renderPaths();
      applyState(data.state);

      var state = data.state || {};
      if (state.last_error) {
        setHero(
          '<span class="hl-critical">最近一次接入失败</span>：' +
          escapeHtml(state.last_error),
          '失败不会被静默忽略；修正配置后可再次点击「接入并拉取数据」。'
        );
      } else if (state.fetch_count > 0) {
        setHero(
          '当前数据源为 <span class="hl-accent">' + escapeHtml(state.active_source || '—') +
          '</span>，已成功拉取 <span class="hl-accent">' + fmtNum(state.fetch_count) +
          '</span> 次，缓存 <span class="hl-accent">' + fmtNum(state.patients_cached) +
          '</span> 位患者的 <span class="hl-accent">' + fmtNum(state.observations_cached) +
          '</span> 条观测。',
          '最近一次拉取时间：' + (state.last_fetch_at || '—')
        );
      } else {
        setHero(
          '尚未接入任何真实数据源。可在下方选择一条通路并配置。',
          '没有真实后端时，可使用「动态监护后端」或「手动录入」两条内置通路。'
        );
      }

      // 若当前选中的通路在目录中，刷新其配置面板
      if (store.selected) selectPath(store.selected);
      setConn('online', '接入服务在线');
      return data;
    }).catch(function (err) {
      // 这一页是**唯一**在后端不可用时需要明确提示"请启动后端服务"的地方：
      // 真实系统对接需要一个进程去读写文件、发起网络连接，浏览器沙箱做不到。
      // 其余页面（动态监护 / 手动录入 / 报告中心 / 观察日志）走的是内置仿真，
      // 不需要后端，不应出现这里的提示。
      setConn('error', '需要后端服务');
      renderBackendRequired(err);
      throw err;
    });
  }

  /** 后端不可用时的提示：只说明需要什么，不铺陈原因。 */
  function renderBackendRequired(err) {
    setHero(
      '<span class="hl-critical">未连接后端服务</span>',
      '接入院内系统需要后端进程；动态监护与手动录入为内置，可直接使用。'
    );
    var grid = $('pathGrid');
    if (grid) {
      grid.innerHTML = '';
      var box = document.createElement('div');
      box.className = 'result-box is-info';
      box.style.margin = 'var(--sp-4)';
      box.innerHTML =
        '<div class="rb-title">启动后端服务后即可接入</div>' +
        '<div class="mono" style="margin-top:6px;font-size:12px;line-height:1.9;">' +
        'python -m uvicorn service.app:app --host 127.0.0.1 --port 8000' +
        '</div>' +
        '<div class="rb-hint" style="margin-top:10px;">' +
        '接口清单与报文示例见 <a href="api.html">接口文档</a>。' +
        '</div>';
      box.title = String(err && err.message ? err.message : '');
      grid.appendChild(box);
    }
    ['probeBtn', 'activateBtn', 'sampleBtn'].forEach(function (id) {
      var node = $(id);
      if (node) node.disabled = true;
    });
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    $('refreshBtn').addEventListener('click', function () {
      refreshState();
      loadProbeHistory();
    });
    $('probeBtn').addEventListener('click', runProbe);
    $('activateBtn').addEventListener('click', runActivate);
    $('sampleBtn').addEventListener('click', runSample);

    var docsBtn = $('docsBtn');
    if (docsBtn) {
      docsBtn.addEventListener('click', function () {
        // 在线调试台由后端提供（/docs）。内置模式下没有可打开的地址，
        // 因此直接转到离线接口文档，而不是给一个打不开的链接。
        var bridge = global.SGBridge;
        if (bridge && bridge.isBuiltin && bridge.isBuiltin()) {
          global.location.href = 'api.html';
          return;
        }
        global.open('http://127.0.0.1:8000/docs', '_blank', 'noopener');
      });
    }

    setConn('offline', '连接中…');

    request('/api/health').then(function () {
      setConn('online', '接入服务在线');
    }).catch(function () {
      setConn('error', '接入服务未响应');
    });

    refreshState().catch(function () { /* 已在 refreshState 内提示 */ });
    loadProbeHistory();

    request('/api/live/scenarios').then(function (data) {
      store.scenarios = (data && data.scenarios) || [];
      renderScenarios();
    }).catch(function (err) {
      $('scenarioBody').innerHTML =
        '<tr><td colspan="6" class="dim">读取监护场景失败：' + escapeHtml(err.message) + '</td></tr>';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
