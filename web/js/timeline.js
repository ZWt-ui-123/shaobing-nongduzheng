/* ============================================================================
 * 哨兵 SepsisGuard —— 病程观察日志页脚本（timeline.js）
 * ----------------------------------------------------------------------------
 * "每位患者一份独立日志"要真正有用，必须满足三件事，本页就是为这三件事服务的：
 *
 *   1. **能跨患者浏览**：交接班时需要知道"今天这个病区有哪些患者有值得关注的
 *      记录"，而不是逐个患者点开报告。
 *   2. **能写**：医护的床旁观察（家属反映、尿量、意识变化）必须能直接补进日志，
 *      与系统自动产生的入院/干预事件并列在同一条时间轴上。
 *   3. **能带走**：可打印、可导出 Markdown，交接班直接打印或粘进病历。
 *
 * 数据来自 `/api/timeline/*`，日志**持久化在磁盘上**，不随服务重启丢失。
 * ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = String(global.SEPSISGUARD_API || '').replace(/\/+$/, '');

  var KIND_ZH = {
    admission: '入院', onset: '病情变化', intervention: '临床干预',
    alert: '系统告警', measurement: '数据采集', note: '医护记录',
    handover: '交接班', error: '异常'
  };

  var State = {
    patients: [],
    current: null,
    entries: [],
    info: null,
    filter: '',
    kind: 'all'
  };

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

  function fmt(value, digits) {
    if (value === null || value === undefined || value === '') return '—';
    var num = Number(value);
    if (!isFinite(num)) return '—';
    return num.toFixed(digits === undefined ? 0 : digits);
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------ *
   * 数据访问：全部经 SGBridge
   * ------------------------------------------------------------------
   * 本页**不直接 fetch**。SGBridge 会自动判断当前该走后端服务还是浏览器
   * 内置仿真内核：
   *   * 后端可用 → 用后端的真实模型产物；
   *   * 后端不可用（例如直接双击打开本页）→ 用页面内置的仿真内核，
   *     功能完整、可交互、可视化，不显示"初始化失败"。
   * 唯一例外是「数据接入」里的真实系统对接，那确实需要一个服务进程。
   * ------------------------------------------------------------------ */
  function request(path, options) {
    return global.SGBridge.route(path, options);
  }

  function setConn(mode, text) {
    var box = $('connBox');
    if (!box) return;
    box.classList.remove('is-online', 'is-offline', 'is-error');
    if (mode) box.classList.add('is-' + mode);
    $('connText').textContent = text;
  }

  /** 顶部「存储位置」徽标：内置模式下日志存在浏览器本地存储里。 */
  function renderSourceBadge() {
    var flag = $('flagSource');
    if (!flag) return;
    var builtin = global.SGBridge && global.SGBridge.isBuiltin();
    if (builtin) {
      flag.textContent = '存储位置：浏览器本地存储';
      flag.style.color = '#fde047';
      flag.style.borderColor = 'rgba(234, 179, 8, 0.5)';
      flag.title = '每位患者一份日志，保存在本浏览器的 localStorage 中；' +
        '刷新页面后仍在，换浏览器或清空站点数据会丢失';
    } else {
      flag.textContent = '存储位置：服务端磁盘';
      flag.style.color = '';
      flag.style.borderColor = '';
      flag.title = '日志写入 data/cache/timelines/，一位患者一个文件，跨进程可读';
    }
  }

  /**
   * 在浏览器里直接触发文件下载。
   * 内置模式下没有后端可以服务 `/api/timeline/...md`，因此导出必须由前端自己完成，
   * 而不能把 location 指过去（那会跳到一个不存在的地址）。
   */
  function downloadText(filename, text) {
    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      global.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      var win = global.open('', '_blank');
      if (win) win.document.write('<pre>' + escapeHtml(text) + '</pre>');
    }
  }

  function flash(kind, title, lines) {
    var box = $('noteResult');
    box.style.display = '';
    box.className = 'result-box is-' + kind;
    clear(box);
    box.appendChild(el('div', 'rb-title', title));
    (lines || []).forEach(function (line) { box.appendChild(el('div', null, line)); });
  }

  /* ------------------------------------------------------------------ *
   * 患者列表
   * ------------------------------------------------------------------ */
  function loadPatients() {
    return request('/api/timeline').then(function (data) {
      State.patients = data.patients || [];
      var stats = data.stats || {};
      $('navStats').textContent = '存储：' + (stats.patients || 0) + ' 位患者 / ' +
        (stats.entries || 0) + ' 条';
      $('heroFactPatients').textContent = stats.patients || 0;
      $('heroFactEntries').textContent = stats.entries || 0;
      $('subjectSub').textContent = '按最近更新排序 · 共 ' + (data.count || 0) + ' 位';
      $('heroSentence').innerHTML =
        '<span class="hl-accent">' + (stats.patients || 0) +
        '</span> 位患者 · <span class="hl-accent">' + (stats.entries || 0) +
        '</span> 条观察记录' +
        (stats.trimmed ? '；较早的 ' + stats.trimmed + ' 条已按容量上限归档' : '') +
        (stats.corrupted_files ? '；<span class="hl-critical">检测到 ' +
          stats.corrupted_files + ' 个文件损坏</span>' : '');

      var nav = clear($('navPatients'));
      if (!State.patients.length) {
        var empty = el('div', 'dim', '尚无日志');
        empty.style.padding = '6px var(--sp-3)';
        empty.style.fontSize = '11px';
        nav.appendChild(empty);
      } else {
        State.patients.slice(0, 30).forEach(function (row) {
          var item = el('div', 'nav-item');
          item.appendChild(el('span', 'nav-icon', '·'));
          item.appendChild(el('span', null, row.patient_id));
          item.appendChild(el('span', 'nav-count', row.n_entries));
          item.addEventListener('click', function () { readPatient(row.patient_id); });
          nav.appendChild(item);
        });
      }
      renderSubjects();
      renderSourceBadge();
      setConn('online', global.SGBridge && global.SGBridge.isBuiltin()
        ? '内置仿真模式' : '后端在线');
      return data;
    }).catch(function (err) {
      $('subjectList').innerHTML =
        '<div class="dim" style="padding:10px;font-size:12px;">读取日志列表失败：' +
        escapeHtml(err.message) + '</div>';
      setConn('error', '异常');
      throw err;
    });
  }

  function renderSubjects() {
    var host = clear($('subjectList'));
    var q = State.filter.trim().toLowerCase();
    var rows = State.patients.filter(function (row) {
      return !q || String(row.patient_id).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) {
      var empty = el('div', 'dim', '没有符合条件的患者');
      empty.style.padding = '10px';
      empty.style.fontSize = '12px';
      host.appendChild(empty);
      return;
    }
    rows.forEach(function (row) {
      var line = el('div', 'subject-row');
      if (State.current === row.patient_id) line.classList.add('is-selected');
      line.appendChild(el('span', 'sr-id', row.patient_id));
      var bits = [row.n_entries + ' 条'];
      if (row.first_hour !== null && row.first_hour !== undefined) {
        bits.push('第 ' + row.first_hour + '–' + row.last_hour + ' 小时');
      }
      bits.push(row.updated_at || '');
      line.appendChild(el('span', null, bits.filter(Boolean).join(' · ')));
      line.addEventListener('click', function () { readPatient(row.patient_id); });
      host.appendChild(line);
    });
  }

  /* ------------------------------------------------------------------ *
   * 读取一位患者的日志
   * ------------------------------------------------------------------ */
  function readPatient(patientId) {
    var pid = (patientId || $('patientInput').value || '').trim();
    if (!pid) {
      $('logSub').textContent = '请先选择或输入患者编号';
      return Promise.resolve();
    }
    $('patientInput').value = pid;
    State.current = pid;
    $('noteBtn').disabled = false;
    $('clearBtn').disabled = false;
    $('logSub').textContent = '正在读取…';

    return request('/api/timeline/' + encodeURIComponent(pid))
      .then(function (data) {
        State.entries = data.entries || [];
        State.info = data.info || {};
        $('tkPatient').textContent = pid;
        $('tkEntries').textContent = State.entries.length;
        $('tkRange').textContent = (State.info.first_hour === null ||
          State.info.first_hour === undefined)
          ? '—' : ('第 ' + State.info.first_hour + '–' + State.info.last_hour + ' 小时');
        $('tkPersisted').textContent = data.persisted ? '是' : '否（仅内存）';
        $('logTitle').textContent = '观察日志 · ' + pid;
        $('logSub').textContent = State.entries.length + ' 条记录' +
          (data.runtime_only_entries
            ? '（含 ' + data.runtime_only_entries + ' 条尚未落盘的引擎记录）' : '') +
          ' · 存储文件 ' + data.path_hint;
        renderLog();
        renderSubjects();
      })
      .catch(function (err) {
        State.entries = [];
        State.info = null;
        $('logTitle').textContent = '观察日志 · ' + pid;
        $('logSub').textContent = '读取失败';
        var body = clear($('logBody'));
        var box = el('div', 'result-box is-fail');
        box.appendChild(el('div', 'rb-title', '没有找到该患者的日志'));
        box.appendChild(el('div', null, '错误：' + err.message));
        box.appendChild(el('div', 'rb-hint',
          '日志只会在三种情况下产生：① 在「动态监护」页推进过该患者所在的队列；' +
          '② 在「手动录入」页提交过该患者的记录；③ 在本页手工写入过记录。'));
        body.appendChild(box);
        $('tkEntries').textContent = '—';
        $('tkRange').textContent = '—';
        $('tkPersisted').textContent = '—';
      });
  }

  function renderLog() {
    var host = clear($('logBody'));
    var rows = State.entries.filter(function (row) {
      return State.kind === 'all' || row.kind === State.kind;
    });
    if (!rows.length) {
      host.appendChild(el('p', 'dim', '当前筛选条件下没有记录。'));
      return;
    }

    // 类型分布概览：先让使用者知道"这份日志里都是些什么"
    var counts = {};
    State.entries.forEach(function (row) {
      counts[row.kind] = (counts[row.kind] || 0) + 1;
    });
    var strip = el('div', 'chip-row');
    strip.style.marginBottom = 'var(--sp-3)';
    Object.keys(counts).forEach(function (kind) {
      var chip = el('span', 'chip' + (State.kind === kind ? ' is-on' : ''),
        (KIND_ZH[kind] || kind) + ' ' + counts[kind]);
      chip.addEventListener('click', function () {
        State.kind = (State.kind === kind) ? 'all' : kind;
        $('kindFilter').value = State.kind;
        renderLog();
      });
      strip.appendChild(chip);
    });
    host.appendChild(strip);

    var tl = el('div', 'timeline');
    rows.forEach(function (row) {
      var node = el('div', 'tl-item is-' + (row.kind || 'note'));
      node.appendChild(el('span', 'tl-hour',
        row.hour === null || row.hour === undefined ? '—' : ('T+' + row.hour + 'h')));
      var message = el('span', 'tl-msg', row.message || '');
      node.appendChild(message);
      var meta = [KIND_ZH[row.kind] || row.kind];
      if (row.source) meta.push(row.source);
      if (row.at) meta.push(row.at);
      if (row.persisted === false) meta.push('尚未落盘');
      node.appendChild(el('div', 'faint', meta.join(' · ')));
      tl.appendChild(node);
    });
    host.appendChild(tl);

    var actions = el('div', 'config-actions');
    var reportBtn = el('button', 'btn is-ghost', '生成该患者的评估报告');
    reportBtn.addEventListener('click', function () {
      global.location.href = 'report.html?patient=' +
        encodeURIComponent(State.current) + '&origin=auto';
    });
    actions.appendChild(reportBtn);
    host.appendChild(actions);
  }

  /* ------------------------------------------------------------------ *
   * 追加记录 / 删除
   * ------------------------------------------------------------------ */
  function appendNote() {
    var pid = State.current;
    if (!pid) { flash('fail', '请先选择患者', []); return; }
    var text = ($('noteText').value || '').trim();
    if (!text) { flash('fail', '记录内容不能为空', ['请填写观察到的情况。']); return; }
    var hourRaw = ($('noteHour').value || '').trim();
    var hour = null;
    if (hourRaw !== '') {
      var parsed = parseInt(hourRaw, 10);
      if (!isFinite(parsed) || parsed < 0) {
        flash('fail', '记录时点无效', ['应为不小于 0 的整数小时。']);
        return;
      }
      hour = parsed;
    }
    $('noteBtn').disabled = true;
    request('/api/timeline/' + encodeURIComponent(pid) + '/note', {
      method: 'POST',
      body: { message: text, hour: hour, kind: $('noteKind').value }
    }).then(function (data) {
      $('noteBtn').disabled = false;
      $('noteText').value = '';
      flash('ok', '已写入日志', [
        '患者 ' + pid + ' 现有 ' + data.info.n_entries + ' 条记录；' +
        '文件已落盘（' + data.info.updated_at + '）。'
      ]);
      readPatient(pid);
      loadPatients();
    }).catch(function (err) {
      $('noteBtn').disabled = false;
      flash('fail', '写入失败', ['错误：' + err.message]);
    });
  }

  function clearPatient() {
    var pid = State.current;
    if (!pid) return;
    if (!global.confirm('确定要删除患者 ' + pid + ' 的全部观察日志吗？此操作不可撤销。')) return;
    request('/api/timeline/' + encodeURIComponent(pid), { method: 'DELETE' })
      .then(function (data) {
        flash('ok', '已删除', ['剩余 ' + data.remaining + ' 位患者有日志。']);
        State.current = null;
        State.entries = [];
        $('logBody').innerHTML =
          '<p class="dim" style="font-size:12px;">日志已删除。请重新选择患者。</p>';
        $('tkPatient').textContent = '—';
        $('tkEntries').textContent = '—';
        $('noteBtn').disabled = true;
        $('clearBtn').disabled = true;
        loadPatients();
      })
      .catch(function (err) {
        flash('fail', '删除失败', ['错误：' + err.message]);
      });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    var params = new URLSearchParams(global.location.search);
    var preset = params.get('patient');
    if (preset) $('patientInput').value = preset;

    $('loadBtn').addEventListener('click', function () { readPatient(); });
    $('reloadBtn').addEventListener('click', function () { loadPatients(); });
    $('noteBtn').addEventListener('click', appendNote);
    $('clearBtn').addEventListener('click', clearPatient);
    $('patientInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') readPatient();
    });
    $('subjectFilter').addEventListener('input', function (ev) {
      State.filter = ev.target.value;
      renderSubjects();
    });
    $('kindFilter').addEventListener('change', function (ev) {
      State.kind = ev.target.value;
      renderLog();
    });
    $('printBtn').addEventListener('click', function () {
      if (!State.entries.length) { $('logSub').textContent = '请先读取一位患者的日志。'; return; }
      global.print();
    });
    $('mdBtn').addEventListener('click', function () {
      if (!State.current) { $('logSub').textContent = '请先读取一位患者的日志。'; return; }
      var pid = State.current;
      $('mdBtn').disabled = true;
      request('/api/timeline/' + encodeURIComponent(pid) + '.md')
        .then(function (text) {
          $('mdBtn').disabled = false;
          downloadText(pid + '_病程观察日志.md',
            typeof text === 'string' ? text : JSON.stringify(text, null, 2));
        })
        .catch(function (err) {
          $('mdBtn').disabled = false;
          $('logSub').textContent = '导出失败：' + err.message;
        });
    });

    setConn('offline', '检测数据来源…');
    request('/api/health')
      .then(function () {
        setConn('online', global.SGBridge && global.SGBridge.isBuiltin()
          ? '内置仿真模式' : '后端在线');
        renderSourceBadge();
      })
      .catch(function () { setConn('error', '异常'); });

    loadPatients().then(function () {
      if (preset || State.patients.length) {
        readPatient(preset || State.patients[0].patient_id);
      }
    }).catch(function () { /* 已提示 */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
