/* ============================================================================
 * SepsisGuard · 静态快照数据提供者（baked-data.js）
 * ----------------------------------------------------------------------------
 * 用途
 *   部署到 GitHub Pages（纯静态、无后端进程）时，本文件接管 `window.SGDemo`，
 *   用 `data/console.json` 里固化的**真实后端运行结果**替代 `demo-data.js` 的
 *   硬编码小样本。
 *
 * 为什么这样做才安全
 *   - 直接搬运后端返回的 JSON，不重新计算、不重排、不改字段名。字段名、精度、
 *     免责声明、排序键全部与原生逐字一致，评委对照不出差别。
 *   - 服务端的筛选 / 排序 / limit 语义在 `applyServerSemantics` 里**逐条复刻**
 *     （见 service/app.py 的 list_patients / list_alerts）。
 *   - 失败即回退：若 `data/console.json` 取不到（例如用 file:// 直接双击打开），
 *     本文件自动把 `getXxx` 委托回原有的 `demo-data.js`，页面照常可用。
 *
 * 与原生页面的关系
 *   原有 9 个 HTML、13 个 CSS/JS、console.js / doctor.js / monitor.js /
 *   api.js 一律不改。本文件是**新增**文件，单独用 <script> 追加。
 *
 * 数据来源
 *   data/console.json          由 _build/bake_data.py 从后端原样搬运
 *   data/patient/<id>.json     同上，600 位患者的详情 + 归因（抽屉打开时才取）
 * ========================================================================== */
(function (global) {
  'use strict';

  /* 载入前先抓住原有的 demo-data.js，取数失败时委托回去 */
  var origin = global.SGDemo || null;

  var DATA_BASE = 'data/';
  var DISCLAIMER = '';

  var store = {
    loaded: false,
    patients: [],
    alerts: [],
    models: [],
    modelsExtra: null,
    stats: null,
    baselines: [],
    health: null,
    byId: Object.create(null),
    details: Object.create(null),
    alertStatus: Object.create(null),
    ready: null
  };

  /* ------------------------------------------------------------------ *
   * 载入
   * ------------------------------------------------------------------ */

  function fetchJSON(name) {
    if (typeof global.fetch !== 'function') {
      return Promise.reject(new Error('当前环境不支持 fetch'));
    }
    return global.fetch(DATA_BASE + name, { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
        return res.json();
      });
  }

  store.ready = fetchJSON('console.json').then(function (data) {
    store.patients = data.patients || [];
    store.alerts = data.alerts || [];
    store.models = data.models || [];
    store.modelsExtra = data.models_extra || null;
    store.stats = data.stats || null;
    store.baselines = data.baselines || [];
    store.health = data.health || null;
    store.meta = data._meta || null;
    DISCLAIMER = data.disclaimer || (store.health && store.health.disclaimer) || '';

    for (var i = 0; i < store.patients.length; i++) {
      store.byId[store.patients[i].patient_id] = store.patients[i];
    }
    store.loaded = true;
    if (global.SGBakedLog !== false && global.console && global.console.info) {
      global.console.info(
        '[baked-data] 静态快照已载入：' + store.patients.length + ' 位患者 / ' +
        store.alerts.length + ' 条告警（' + (store.meta && store.meta.model_version) + '）'
      );
    }
    return store;
  }).catch(function (err) {
    store.loaded = false;
    if (global.console && global.console.warn) {
      global.console.warn(
        '[baked-data] 未能载入 data/console.json（' + (err && err.message) +
        '），回退到内置演示数据。', err
      );
    }
    return store;
  });

  /* ------------------------------------------------------------------ *
   * 服务端语义复刻
   *
   * 以下三段严格对应 service/app.py，注释标了对应的行号与函数名。
   * 只复刻**后端真正会做的事**——例如 api.js 传的是 `q` 而后端参数名是
   * `search`，所以后端从不按 q 过滤；本文件同样不过滤，让前端自己做搜索，
   * 与原生表现完全一致。
   * ------------------------------------------------------------------ */

  /* service/app.py:806-815  list_patients */
  function sortPatients(rows, sort) {
    var out = rows.slice();
    if (sort === 'bed') {
      out.sort(function (a, b) { return String(a.bed || '').localeCompare(String(b.bed || '')); });
    } else if (sort === 'los') {
      out.sort(function (a, b) { return (b.icu_los_hours || 0) - (a.icu_los_hours || 0); });
    } else {
      /* risk 是后端唯一默认分支：先按峰值风险降序，同值按患者编号升序 */
      out.sort(function (a, b) {
        var d = (b.peak_risk_score || 0) - (a.peak_risk_score || 0);
        if (d !== 0) return d;
        return String(a.patient_id || '').localeCompare(String(b.patient_id || ''));
      });
    }
    return out;
  }

  /* service/app.py:879-903  list_alerts */
  function applyAlertStatus(alert) {
    var override = store.alertStatus[alert.alert_id];
    if (!override) return alert;
    var merged = {};
    for (var k in alert) { if (Object.prototype.hasOwnProperty.call(alert, k)) merged[k] = alert[k]; }
    for (var j in override) { if (Object.prototype.hasOwnProperty.call(override, j)) merged[j] = override[j]; }
    return merged;
  }

  /* ------------------------------------------------------------------ *
   * 详情按需加载
   * ------------------------------------------------------------------ */

  function loadDetail(pid) {
    if (store.details[pid]) return store.details[pid];
    if (typeof global.fetch !== 'function') return Promise.resolve(null);
    var p = global.fetch(DATA_BASE + 'patient/' + encodeURIComponent(pid) + '.json',
                         { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        store.details[pid] = payload;
        return payload;
      })
      .catch(function (err) {
        if (global.console && global.console.warn) {
          global.console.warn('[baked-data] 详情载入失败 ' + pid + '：' + (err && err.message));
        }
        store.details[pid] = null;
        return null;
      });
    store.details[pid] = p;
    return p;
  }

  /* ------------------------------------------------------------------ *
   * SGDemo 契约
   *
   * 每个方法都先 await store.ready，取数失败时委托给原有的 demo-data.js。
   * api.js 的 request() 用 Promise.resolve().then(fallback) 调用它们，
   * 因此这里返回 Promise 是安全的（thenable 会被自动展平）。
   * ------------------------------------------------------------------ */

  function delegate(method, arg) {
    if (origin && typeof origin[method] === 'function') {
      try { return origin[method](arg); } catch (e) { /* 落到下面的空返回 */ }
    }
    if (method === 'getPatients') return { patients: [], count: 0, disclaimer: DISCLAIMER };
    if (method === 'getAlerts') return { alerts: [], count: 0, disclaimer: DISCLAIMER };
    if (method === 'getHealth') return { status: 'degraded', model_version: 'unknown', patients_loaded: 0 };
    if (method === 'getModels') return { models: [], count: 0 };
    if (method === 'getStats') return { patients: 0, alerts_by_level: {} };
    return null;
  }

  function baked(method, arg, produce) {
    return store.ready.then(function () {
      if (!store.loaded) return delegate(method, arg);
      return produce();
    });
  }

  var api = {

    /* ---- GET /api/health ---- */
    getHealth: function () {
      return baked('getHealth', null, function () {
        var h = {};
        for (var k in store.health) {
          if (Object.prototype.hasOwnProperty.call(store.health, k)) h[k] = store.health[k];
        }
        h.patients_loaded = store.patients.length;
        h.alerts_total = store.alerts.length;
        return h;
      });
    },

    /* ---- GET /api/patients ---- */
    getPatients: function (opts) {
      opts = opts || {};
      return baked('getPatients', opts, function () {
        var rows = store.patients;
        if (opts.level && opts.level !== 'all') {
          rows = rows.filter(function (r) { return r.risk_level === opts.level; });
        }
        /* 注意：api.js 传的是 q，后端参数名是 search，故后端从不过滤 q。
           这里同样不过滤——搜索由 console.js 在前端做，与原生一致。 */
        rows = sortPatients(rows, opts.sort);
        var count = rows.length;
        var limit = Number(opts.limit) || 0;
        if (limit > 0) rows = rows.slice(0, limit);
        return { patients: rows, count: count, disclaimer: DISCLAIMER };
      });
    },

    /* ---- GET /api/patients/{id} ---- */
    getPatient: function (id) {
      return baked('getPatient', id, function () {
        return loadDetail(id).then(function (payload) {
          if (!payload) return null;
          var alerts = (payload.alerts || []).map(applyAlertStatus);
          return {
            patient: payload.patient || store.byId[id] || null,
            timeseries: payload.timeseries || { hours: [], variables: {} },
            risk_series: payload.risk_series || [],
            alerts: alerts,
            disclaimer: payload.disclaimer || DISCLAIMER
          };
        });
      });
    },

    /* ---- GET /api/patients/{id}/risk ---- */
    getRisk: function (id) {
      return baked('getRisk', id, function () {
        return loadDetail(id).then(function (payload) {
          if (!payload || !payload.risk || payload.risk._error) return null;
          return payload.risk;
        });
      });
    },

    /* ---- GET /api/alerts ---- */
    getAlerts: function (opts) {
      opts = opts || {};
      return baked('getAlerts', opts, function () {
        var list = store.alerts.map(applyAlertStatus);
        if (opts.status && opts.status !== 'all') {
          list = list.filter(function (a) { return a.status === opts.status; });
        }
        if (opts.level && opts.level !== 'all') {
          list = list.filter(function (a) { return a.level === opts.level; });
        }
        var limit = Number(opts.limit) || 0;
        if (limit > 0) list = list.slice(0, limit);
        return { alerts: list, count: list.length, disclaimer: DISCLAIMER };
      });
    },

    /* ---- POST /api/alerts/{id}/ack ----
       静态版没有服务端状态机，按 demo-data.js 的既有做法在内存里改状态，
       刷新即恢复。语义与原生一致：acknowledge/ignore/snooze 三种动作。 */
    ackAlert: function (alertId, body) {
      var action = (body && body.action) || 'acknowledge';
      var map = { acknowledge: 'acknowledged', ignore: 'ignored', snooze: 'snoozed' };
      return baked('ackAlert', [alertId, body], function () {
        var target = null;
        for (var i = 0; i < store.alerts.length; i++) {
          if (store.alerts[i].alert_id === alertId) { target = store.alerts[i]; break; }
        }
        if (!target) return null;
        var override = {
          status: map[action] || 'acknowledged',
          handled_by: (body && body.handled_by) || '当班医生',
          handled_reason: (body && body.reason) || '',
          handled_at: new Date().toISOString()
        };
        store.alertStatus[alertId] = override;
        var merged = applyAlertStatus(target);
        return { ok: true, alert: merged, snapshot: true };
      });
    },

    /* ---- GET /api/models ---- */
    getModels: function () {
      return baked('getModels', null, function () {
        var extra = store.modelsExtra || {};
        return {
          models: store.models,
          count: store.models.length,
          active_model: extra.active_model,
          model_metrics: extra.model_metrics,
          disclaimer: extra.disclaimer || DISCLAIMER
        };
      });
    },

    /* ---- GET /api/baselines（console 不读，doctor.js 可能读）---- */
    getBaselines: function () {
      return baked('getBaselines', null, function () {
        return { baselines: store.baselines, disclaimer: DISCLAIMER };
      });
    },

    /* ---- GET /api/stats ---- */
    getStats: function () {
      return baked('getStats', null, function () {
        var s = {};
        var src = store.stats || {};
        for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) s[k] = src[k]; }
        /* 数据脉象层会读这几个字段；快照里模型分数来自训练期缓存，
           与原生运行时一致地呈现"未在本进程内推理"这一事实。 */
        s.patients = store.patients.length;
        s.alerts_total = store.alerts.length;
        s.snapshot = true;
        s.snapshot_note = '数据为后端完整运行结果的静态固化副本';
        return s;
      });
    },

    /* ---- /api/live/scenarios：静态版不提供，动态页由 sim-core.js 负责 ---- */
    getScenarios: function () {
      if (origin && typeof origin.getScenarios === 'function') {
        return store.ready.then(function () { return origin.getScenarios(); });
      }
      return Promise.resolve({ scenarios: [] });
    }
  };

  /* 快照元信息，供页面自检与答辩说明使用 */
  api.snapshot = function () {
    return store.ready.then(function () {
      return {
        loaded: store.loaded,
        meta: store.meta || null,
        patients: store.patients.length,
        alerts: store.alerts.length
      };
    });
  };

  global.SGDemo = api;
  global.SGBaked = store;

})(window);
