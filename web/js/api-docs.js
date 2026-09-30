/* 哨兵 SepsisGuard —— 接口文档页
 *
 * 职责：探测本机服务是否可达、渲染接口清单、提供一次真实的报文接收联调。
 * 本页不依赖仿真内核：服务不可达时只显示离线文档与启动方式，
 * 不伪造"已连接"的状态。
 */
(function (global) {
  'use strict';

  var LOCAL = 'http://127.0.0.1:8000';
  var BASE = '';

  function $(id) { return document.getElementById(id); }

  function setConn(mode, text) {
    var box = $('connBox');
    if (box) {
      box.classList.remove('is-online', 'is-offline', 'is-error');
      if (mode) box.classList.add('is-' + mode);
    }
    if ($('connText')) $('connText').textContent = text;
    if ($('svcState')) $('svcState').textContent = text;
  }

  function request(path, options) {
    return fetch((BASE || '') + path, options || {}).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  var ENDPOINTS = [
    ['POST', '/api/ingest/hl7', '接收 HL7 v2.x 报文', 'message、source_label'],
    ['GET', '/api/ingest/hl7/sample', '取示例 HL7 报文', '无'],
    ['POST', '/api/ingest/hl7/demo', '用示例报文做一次真实接收', 'source_label（可选）'],
    ['POST', '/api/ingest/webhook', '接收设备/护理终端推送', 'patient_id、values、record_time'],
    ['GET', '/api/ingest/webhook/stats', '推送接收统计', '无'],
    ['POST', '/api/ingest/webhook/drain', '把缓冲数据装配成队列', '无'],
    ['GET', '/api/sources', '列出可用数据源与配置项', '无'],
    ['POST', '/api/sources/probe', '连通性与数据可用性自检', 'kind、address 等配置'],
    ['POST', '/api/sources/activate', '启用数据源并拉取数据', 'kind、address 等配置'],
    ['GET', '/api/sources/sample', '读取原始样本（不落库）', 'kind、address 等配置'],
    ['GET', '/api/live/patients', '当前在监患者与风险', '无'],
    ['POST', '/api/live/start', '启动动态监护引擎', 'n_patients、scenario、seed'],
    ['POST', '/api/live/advance', '推进虚拟时间并重新评分', 'hours'],
    ['GET', '/api/report/patient/{id}', '生成单例评估报告', '路径参数：患者编号'],
    ['GET', '/api/timeline/{id}', '读取患者观察日志', '路径参数：患者编号'],
    ['POST', '/api/timeline/{id}/note', '追加一条医护记录', 'hour、kind、message'],
    ['GET', '/openapi.json', '机器可读接口定义', '无']
  ];

  function renderEndpoints() {
    var body = $('endpointBody');
    if (!body) return;
    ENDPOINTS.forEach(function (row) {
      var tr = document.createElement('tr');

      var tdMethod = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'method is-' + row[0].toLowerCase();
      tag.textContent = row[0];
      tdMethod.appendChild(tag);
      tr.appendChild(tdMethod);

      var tdPath = document.createElement('td');
      tdPath.className = 'mono';
      tdPath.textContent = row[1];
      tr.appendChild(tdPath);

      var tdUse = document.createElement('td');
      tdUse.textContent = row[2];
      tr.appendChild(tdUse);

      var tdBody = document.createElement('td');
      tdBody.className = 'faint';
      tdBody.textContent = row[3];
      tr.appendChild(tdBody);

      body.appendChild(tr);
    });
  }

  function show(title, payload) {
    var box = $('resultBox');
    if (!box) return;
    box.textContent = title + '\n\n' +
      (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  }

  function detect() {
    /* ---- [静态快照版 · 新增] ------------------------------------------------
     * 部署在 GitHub Pages 时没有后端进程。去探 http://127.0.0.1:8000 必然
     * 连接被拒：那会在控制台留下一条红色报错，也会给评委"功能坏了"的错觉。
     * 这里不发请求，直接给出如实说明。原生版没有这个分支，行为完全不变。
     * -------------------------------------------------------------------- */
    if (global.SGBakedSnapshot) {
      setConn('offline', '静态快照版 · 无后端进程');
      if ($('baseUrl')) $('baseUrl').textContent = '（静态快照，不含服务端点）';
      if ($('svcHint')) {
        $('svcHint').textContent =
          '本页是静态快照，不含服务端进程，因此无法在此完成真实报文的接收联调。' +
          '接口定义、报文格式与示例均可离线查看；需要实际接收数据时，' +
          '在部署端启动服务后再打开本页：' +
          'python -m uvicorn service.app:app --host 127.0.0.1 --port 8000';
      }
      return Promise.resolve(false);
    }
    return fetch(LOCAL + '/api/health').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (info) {
      BASE = LOCAL;
      setConn('online', '服务已连接');
      if ($('baseUrl')) $('baseUrl').textContent = LOCAL;
      if ($('svcHint')) {
        $('svcHint').textContent = '服务正在运行（' +
          (info.model_name || '模型已加载') + '，已装载 ' +
          (info.patients_loaded || 0) + ' 位患者）。可直接点击「接收示例报文」完成一次真实接入。';
      }
      return true;
    }).catch(function () {
      BASE = '';
      setConn('offline', '未连接服务');
      if ($('svcHint')) {
        $('svcHint').textContent = '当前未检测到本机服务进程。接口文档与报文示例可离线查看；' +
          '需要实际接收数据时，先启动服务：' +
          'python -m uvicorn service.app:app --host 127.0.0.1 --port 8000';
      }
      return false;
    });
  }

  function runDemo() {
    var btn = $('demoBtn');
    if (btn) btn.disabled = true;
    /* [静态快照版] 没有服务端进程，与其发一个注定失败的请求，不如说清楚原因 */
    if (global.SGBakedSnapshot) {
      show('本页无法接收报文',
        '静态快照不含服务端进程，而真实报文接收需要一个能读文件、发连接的进程' +
        '（浏览器沙箱做不到）。这是浏览器安全模型的硬限制，与本系统实现无关。' +
        '\n\n接口定义与报文格式见本页左侧与下方，可离线查看。');
      if (btn) btn.disabled = false;
      return;
    }
    show('正在接收示例报文…', '');
    request('/api/ingest/hl7/demo', { method: 'POST' }).then(function (data) {
      if (data.ok) {
        show('接收成功：报文 ' + data.n_messages + ' 条，患者 ' + data.patients.length +
          ' 位，指标 ' + data.variables.length + ' 项，落库 ' + data.stored_entries +
          ' 条，耗时 ' + data.elapsed_ms + ' 毫秒', data);
      } else {
        show('接收未通过：' + data.reason, data);
      }
    }).catch(function (err) {
      show('接收失败：' + err.message,
        '需要先启动服务进程：\npython -m uvicorn service.app:app --host 127.0.0.1 --port 8000');
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  function runSample() {
    /* [静态快照版] 同上：示例报文由服务端读取，静态快照里没有 */
    if (global.SGBakedSnapshot) {
      show('本页无法读取示例报文',
        '示例 HL7 文件在服务端磁盘上（data/hl7_demo.hl7），' +
        '需要服务端进程才能读取。页面下方已完整列出报文格式，可直接对照查看。');
      return;
    }
    request('/api/ingest/hl7/sample').then(function (data) {
      show('示例报文（' + data.file + '）', data.message);
    }).catch(function (err) {
      show('读取失败：' + err.message, '需要先启动服务进程。');
    });
  }

  function boot() {
    renderEndpoints();
    if ($('demoBtn')) $('demoBtn').addEventListener('click', runDemo);
    if ($('sampleBtn')) $('sampleBtn').addEventListener('click', runSample);
    if ($('recheckBtn')) $('recheckBtn').addEventListener('click', detect);
    detect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
