// ==UserScript==
// @name         BOSS直聘-自动筛选打招呼 v2.3
// @namespace    http://tampermonkey.net/
// @version      2.3.0
// @description  在Boss直聘「推荐牛人 -> 推荐 Tab」页面，按自定义筛选条件自动打招呼
// @author       dalaolee
// @match        https://www.zhipin.com/web/frame/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // =====================================================================
  // ======================== 默认配置 ===================================
  // =====================================================================

  const DEFAULT_COMPANY_LIST = [
    "百度", "阿里", "淘宝", "天猫", "支付宝", "蚂蚁",
    "腾讯", "微信", "字节跳动", "抖音", "TikTok", "飞书",
    "美团", "华为", "京东",
    "快手", "拼多多", "网易",
    "小米", "OPPO", "vivo", "荣耀",
    "滴滴", "哔哩哔哩", "B站", "小红书",
    "携程", "去哪儿", "微博", "知乎",
    "58同城", "贝壳", "链家",
    "大疆", "蔚来", "小鹏", "理想",
    "货拉拉", "SHEIN", "米哈游",
    "智谱", "MiniMax", "月之暗面", "Moonshot",
    "百川智能", "百川", "零一万物",
    "深度求索", "DeepSeek",
    "商汤", "旷视", "依图", "云从",
    "第四范式", "昆仑万维", "面壁智能",
    "阶跃星辰", "光年之外",
    "科大讯飞", "思谋科技",
    "微软", "Microsoft", "Google", "谷歌",
    "Apple", "苹果", "Amazon", "亚马逊",
    "Meta", "Facebook", "OpenAI",
    "英伟达", "NVIDIA", "英特尔", "Intel",
    "IBM", "Oracle", "SAP",
  ];

  const DEFAULT_POSITION_KEYWORDS = ["算法"];

  const DEFAULT_CONFIG = {
    jobId: "",
    apiFilter: {
      age: "16,-1", activation: 0, school: "1104,1103,1102,1106",
      recentNotView: 0, switchJobFrequency: 0, exchangeResumeWithColleague: 0,
      gender: 0, keyword1: -1, major: 0, degree: 0,
      experience: "110,103,104,105,106", intention: 0, salary: 0, firstDegree: 999,
    },
    companyWhiteList: DEFAULT_COMPANY_LIST,
    positionKeywords: DEFAULT_POSITION_KEYWORDS,
    excludeFreshGraduate: true,
    greetDelayMin: 6000,
    greetDelayMax: 15000,
    maxGreetPerDay: 50,
    maxPages: 10,
    pageDelayMin: 15000,
    pageDelayMax: 30000,
    cooldownMin: 180000,
    cooldownMax: 420000,
    workHourStart: 9,
    workHourEnd: 21,
    enabled: false,
  };

  // =====================================================================
  // ======================== 全局状态 ===================================
  // =====================================================================

  const LOG_PREFIX = "[BOSS自动招呼]";
  let config = null;
  let isRunning = false;
  let mainLoopTimer = null;
  let filterLog = [];
  let batchLog = [];

  // ======================== 工具函数 ========================

  function log(...args) { console.log(`%c${LOG_PREFIX}`, "color:#00b38a;font-weight:bold", ...args); }
  function warn(...args) { console.warn(`${LOG_PREFIX}`, ...args); }
  function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  function sleep(minMs, maxMs) { return new Promise(r => setTimeout(r, maxMs ? randomInt(minMs, maxMs) : minMs)); }

  function getTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  function getTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  }
  function getTodayGreetCount() {
    return (GM_getValue("boss_greet_count", {}))[getTodayKey()] || 0;
  }
  function addTodayGreetCount(n = 1) {
    const data = GM_getValue("boss_greet_count", {});
    const key = getTodayKey();
    data[key] = (data[key] || 0) + n;
    const keys = Object.keys(data).sort();
    while (keys.length > 7) delete data[keys.shift()];
    GM_setValue("boss_greet_count", data);
    return data[key];
  }
  function isWorkingHour() {
    const h = new Date().getHours();
    return h >= config.workHourStart && h < config.workHourEnd;
  }
  function extractJobIdFromUrl() {
    try { const u = new URL(window.location.href); return u.searchParams.get("jobid") || u.searchParams.get("jobId") || ""; }
    catch { return ""; }
  }
  function getJobId() {
    if (config.jobId) return config.jobId;
    const fromUrl = extractJobIdFromUrl();
    if (fromUrl) { config.jobId = fromUrl; return fromUrl; }
    return "";
  }
  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = randomInt(0, i); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // ======================== 配置持久化 ========================

  function loadConfig() {
    const saved = GM_getValue("boss_auto_greet_config", null);
    if (saved) {
      config = { ...DEFAULT_CONFIG, ...saved };
      config.apiFilter = { ...DEFAULT_CONFIG.apiFilter, ...(saved.apiFilter || {}) };
      if (typeof config.companyWhiteList === "string")
        config.companyWhiteList = config.companyWhiteList.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      if (typeof config.positionKeywords === "string")
        config.positionKeywords = config.positionKeywords.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  }
  function saveConfig() { GM_setValue("boss_auto_greet_config", config); }

  // =====================================================================
  // ======================== 实时面板更新 ===============================
  // =====================================================================

  function addLiveFeedItem(entry) {
    const container = document.getElementById("bag-live-feed");
    if (!container) return;
    const placeholder = container.querySelector(".bag-live-empty");
    if (placeholder) placeholder.remove();

    const item = document.createElement("div");
    item.className = "bag-live-item";
    item.style.cssText = `padding:6px 8px;border-radius:8px;margin-bottom:4px;background:${entry.bgColor||"#f6f8fa"};line-height:1.5;animation:bag-fade-in .3s ease;`;
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:600;color:${entry.color||"#333"};font-size:12px;">${entry.icon} ${entry.name}</span>
        <span style="font-size:10px;color:#bbb;">${getTimeStr()}</span>
      </div>
      <div style="font-size:11px;color:#888;margin-top:1px;">${entry.info}</div>
      ${entry.detail ? `<div style="font-size:10px;color:#aaa;margin-top:1px;">${entry.detail}</div>` : ""}
    `;
    container.prepend(item);
    const items = container.querySelectorAll(".bag-live-item");
    if (items.length > 20) for (let i = 20; i < items.length; i++) items[i].remove();
  }

  function addBatchHeader(page, total, passed, rejected, reasons) {
    const reasonStr = Object.entries(reasons).map(([k,v]) => `${k}:${v}`).join(" ");
    const entry = {
      time: getTimeStr(), page, total, passed, rejected, reasonStr,
    };
    batchLog.push(entry);

    addLiveFeedItem({
      icon: "📦", name: `批次 #${batchLog.length}  第${page}页`,
      color: "#1677ff", bgColor: "#e6f4ff",
      info: `API返回 ${total} 人 → ✅通过 ${passed} · ❌淘汰 ${rejected}`,
      detail: reasonStr ? `淘汰原因: ${reasonStr}` : "",
    });
  }

  function showCurrentCandidate(name, info) {
    const el = document.getElementById("bag-current");
    if (!el) return;
    el.innerHTML = `<div style="display:flex;align-items:center;gap:6px;"><span class="bag-pulse"></span><span style="font-weight:600;color:#fa8c16;">${name}</span></div><div style="font-size:11px;color:#888;margin-top:2px;">${info}</div>`;
    el.style.display = "block";
  }
  function hideCurrentCandidate() {
    const el = document.getElementById("bag-current");
    if (el) { el.style.display = "none"; el.innerHTML = ""; }
  }

  // =====================================================================
  // ======================== 过滤逻辑 ==================================
  // =====================================================================

  function evaluateGeek(geek) {
    const card = geek.geekCard;
    if (!card) return { pass: false, reason: "无geekCard", detail: "" };
    const works = card.geekWorks || [];
    const workYear = card.geekWorkYear || "";
    const freshGrad = card.freshGraduate || 0;

    if (config.excludeFreshGraduate) {
      if (workYear.includes("应届") || freshGrad > 0)
        return { pass: false, reason: "应届生", detail: `${workYear}, freshGraduate=${freshGrad}` };
    }
    if (config.companyWhiteList.length > 0) {
      const match = works.some(w => config.companyWhiteList.some(t => (w.company||"").includes(t)));
      if (!match) return { pass: false, reason: "公司不匹配", detail: works.map(w=>w.company||"无").join(", ") };
    }
    if (config.positionKeywords.length > 0) {
      const match = works.some(w => config.positionKeywords.some(kw => (w.positionCategory||"").includes(kw)));
      if (!match) return { pass: false, reason: "职位不匹配", detail: works.map(w=>w.positionCategory||"无").join(", ") };
    }
    return { pass: true, reason: "通过", detail: works.map(w=>`${w.company}·${w.positionCategory}`).join(" | ") };
  }

  function filterGeekList(geekList, page) {
    if (!geekList || !geekList.length) return [];
    const reasons = {};
    let passed = 0;
    const result = [];

    for (const geek of geekList) {
      const card = geek.geekCard || {};
      const name = card.geekName || "未知";
      const works = (card.geekWorks||[]).map(w=>({company:w.company||"",position:w.positionCategory||""}));
      const worksStr = works.map(w=>`${w.company}·${w.position}`).join(" | ") || "无经历";

      const verdict = evaluateGeek(geek);
      filterLog.push({
        name, degree: card.geekDegree||"", workYear: card.geekWorkYear||"",
        works, result: verdict.pass ? "pass" : "reject",
        reason: verdict.reason, detail: verdict.detail, time: getTimeStr(),
      });

      if (verdict.pass) {
        passed++;
        result.push(geek);
        addLiveFeedItem({ icon:"✅", name, color:"#00b38a", bgColor:"#f0faf7", info:worksStr, detail:"筛选通过" });
      } else {
        reasons[verdict.reason] = (reasons[verdict.reason]||0) + 1;
        addLiveFeedItem({ icon:"❌", name, color:"#ff4d4f", bgColor:"#fff5f5", info:worksStr, detail:`淘汰: ${verdict.reason}` });
      }
    }

    addBatchHeader(page, geekList.length, passed, geekList.length - passed, reasons);
    updatePanelStats(geekList.length, passed, geekList.length - passed, reasons);
    updateLogPanel();
    return result;
  }

  // =====================================================================
  // ======================== API 调用 ==================================
  // =====================================================================

  let nativeFetch = null;

  async function fetchGeekListDirect(page = 1) {
    const jobId = getJobId();
    if (!jobId) throw new Error("jobId 为空");
    const f = config.apiFilter;
    const params = new URLSearchParams({
      age:f.age, activation:f.activation, school:f.school,
      recentNotView:f.recentNotView, switchJobFrequency:f.switchJobFrequency,
      exchangeResumeWithColleague:f.exchangeResumeWithColleague,
      gender:f.gender, keyword1:f.keyword1, major:f.major,
      degree:f.degree, experience:f.experience,
      intention:f.intention, salary:f.salary, firstDegree:f.firstDegree,
      jobId, page, coverScreenMemory:1, cardType:0,
    });
    const resp = await nativeFetch(`https://www.zhipin.com/wapi/zpjob/rec/geek/list?${params}`, {
      method:"GET", credentials:"include",
      headers:{ Accept:"application/json, text/plain, */*", "X-Requested-With":"XMLHttpRequest" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`code=${data.code} msg=${data.message}`);
    return data;
  }

  async function greetGeekByApi(geek) {
    const card = geek.geekCard;
    if (!card) return false;
    const gid = geek.encryptGeekId || card.encryptGeekId || card.encGeekId || "";
    const securityId = card.securityId || "";
    const lid = card.lid || "";
    const expectId = card.expectId || "";
    const jid = getJobId();
    if (!gid || !securityId || !jid) { warn("缺少参数:", {gid:!!gid,securityId:!!securityId,jid:!!jid}); return false; }

    const body = new URLSearchParams({
      gid, suid:"", jid, expectId:String(expectId), lid,
      greet:"", from:"", securityId, customGreetingGuide:"-1",
    });
    try {
      const resp = await nativeFetch("https://www.zhipin.com/wapi/zpjob/chat/start", {
        method:"POST", credentials:"include",
        headers:{ "Content-Type":"application/x-www-form-urlencoded", Accept:"application/json, text/plain, */*", "X-Requested-With":"XMLHttpRequest" },
        body: body.toString(),
      });
      if (!resp.ok) { warn(`HTTP ${resp.status}`); return false; }
      const data = await resp.json();
      if (data.code === 0) { log(`🤝 [${card.geekName}] 成功`); return true; }
      if (data.code === 1) { log(`ℹ️ [${card.geekName}] 已沟通过`); return false; }
      warn(`[${card.geekName}] code=${data.code} msg=${data.message}`);
      return false;
    } catch(err) { warn(`[${card.geekName}] 请求失败:`, err); return false; }
  }

  // =====================================================================
  // ======================== 主循环 ====================================
  // =====================================================================

  async function mainLoop() {
    if (!isRunning) return;
    if (!isWorkingHour()) {
      updateStatus("⏸ 不在工作时间，等待中...");
      mainLoopTimer = setTimeout(mainLoop, 5*60*1000);
      return;
    }
    if (getTodayGreetCount() >= config.maxGreetPerDay) {
      updateStatus(`🚫 今日已达上限 (${getTodayGreetCount()})`);
      stopAutoGreet();
      return;
    }
    updateStatus("🔄 正在运行...");

    let currentPage = 1;
    let totalGreeted = 0;

    try {
      while (isRunning && currentPage <= config.maxPages) {
        if (getTodayGreetCount() >= config.maxGreetPerDay) break;

        addLiveFeedItem({ icon:"📄", name:`请求第 ${currentPage} 页`, color:"#1677ff", bgColor:"#f0f5ff", info:"正在调用 API..." });

        let apiData;
        try { apiData = await fetchGeekListDirect(currentPage); }
        catch(err) {
          warn("API 失败:", err.message);
          addLiveFeedItem({ icon:"⚠️", name:"API 错误", color:"#fa8c16", bgColor:"#fff7e6", info:err.message });
          updateStatus("⚠️ API 失败，等待重试...");
          await sleep(30000, 60000);
          break;
        }

        const rawList = apiData?.zpData?.geekList || [];
        if (rawList.length === 0) {
          addLiveFeedItem({ icon:"📭", name:"无更多候选人", color:"#999", bgColor:"#f6f8fa", info:"本轮结束" });
          break;
        }

        const filtered = filterGeekList(rawList, currentPage);

        if (filtered.length === 0) {
          currentPage++;
          await sleep(config.pageDelayMin, config.pageDelayMax);
          continue;
        }

        const shuffled = shuffleArray(filtered);
        for (let i = 0; i < shuffled.length; i++) {
          if (!isRunning || getTodayGreetCount() >= config.maxGreetPerDay) break;

          const geek = shuffled[i];
          const card = geek.geekCard || {};
          const name = card.geekName || "未知";
          const worksStr = (card.geekWorks||[]).map(w=>`${w.company}·${w.positionCategory}`).join(" | ");

          showCurrentCandidate(name, `🤝 打招呼中 (${i+1}/${shuffled.length}) — ${worksStr}`);
          updateStatus(`🤝 ${name} (${i+1}/${shuffled.length})`);

          const ok = await greetGeekByApi(geek);
          if (ok) {
            totalGreeted++;
            const total = addTodayGreetCount();
            updatePanelGreetCount();
            const logEntry = filterLog.findLast(e => e.name === name && e.result === "pass");
            if (logEntry) logEntry.result = "greet_ok";
            addLiveFeedItem({ icon:"🤝", name, color:"#52c41a", bgColor:"#f6ffed", info:worksStr, detail:`成功！今日 ${total}/${config.maxGreetPerDay}` });
          } else {
            const logEntry = filterLog.findLast(e => e.name === name && e.result === "pass");
            if (logEntry) logEntry.result = "greet_fail";
            addLiveFeedItem({ icon:"⚠️", name, color:"#fa8c16", bgColor:"#fff7e6", info:worksStr, detail:"失败或已沟通" });
          }
          hideCurrentCandidate();
          updateLogPanel();

          if (i < shuffled.length - 1) {
            const d = randomInt(config.greetDelayMin, config.greetDelayMax);
            updateStatus(`⏳ ${(d/1000).toFixed(0)}s`);
            await sleep(d);
          }
        }

        if (isRunning && currentPage < config.maxPages) {
          const d = randomInt(config.pageDelayMin, config.pageDelayMax);
          updateStatus(`⏳ 翻页 ${(d/1000).toFixed(0)}s`);
          await sleep(d);
          currentPage++;
        } else break;
      }
    } catch(err) { warn("主循环异常:", err); }

    if (isRunning) {
      const cd = randomInt(config.cooldownMin, config.cooldownMax);
      updateStatus(`😴 冷却 ${(cd/1000/60).toFixed(1)}min`);
      addLiveFeedItem({ icon:"😴", name:"本轮结束", color:"#999", bgColor:"#f6f8fa", info:`打了 ${totalGreeted} 个，冷却 ${(cd/1000/60).toFixed(1)}min 后继续` });
      mainLoopTimer = setTimeout(mainLoop, cd);
    }
  }

  function startAutoGreet() {
    if (isRunning) return;
    const jobId = getJobId();
    if (!jobId) { alert("未找到 jobId！请确保在推荐牛人页面，或手动配置。"); return; }
    isRunning = true; config.enabled = true; saveConfig();
    updateToggleBtn();
    addLiveFeedItem({ icon:"🚀", name:"已启动", color:"#00b38a", bgColor:"#f0faf7", info:`jobId: ${jobId}` });
    const d = randomInt(3000, 6000);
    updateStatus(`🔄 ${(d/1000).toFixed(1)}s 后开始...`);
    mainLoopTimer = setTimeout(mainLoop, d);
  }

  function stopAutoGreet() {
    isRunning = false; config.enabled = false; saveConfig();
    if (mainLoopTimer) { clearTimeout(mainLoopTimer); mainLoopTimer = null; }
    updateToggleBtn(); hideCurrentCandidate();
    updateStatus(`⏸ 已暂停（今日 ${getTodayGreetCount()}/${config.maxGreetPerDay}）`);
    addLiveFeedItem({ icon:"⏹", name:"已停止", color:"#999", bgColor:"#f6f8fa", info:`今日 ${getTodayGreetCount()} 个` });
  }

  // =====================================================================
  // ======================== UI =======================
  // =====================================================================

  let panelDOM = {};

  function updateStatus(t) { if (panelDOM.status) panelDOM.status.textContent = t; }
  function updateToggleBtn() {
    if (!panelDOM.toggleBtn) return;
    panelDOM.toggleBtn.textContent = isRunning ? "⏹ 停止" : "▶ 开始";
    panelDOM.toggleBtn.style.background = isRunning ? "#ff4d4f" : "#00b38a";
  }
  function updatePanelGreetCount() {
    if (panelDOM.greetCount) panelDOM.greetCount.textContent = `${getTodayGreetCount()} / ${config.maxGreetPerDay}`;
  }
  function updatePanelStats(total, passed, rejected, reasons) {
    if (panelDOM.filterStats) {
      const r = Object.entries(reasons||{}).map(([k,v])=>`${k}:${v}`).join("  ");
      panelDOM.filterStats.textContent = `最近批次: ${total}人 → 通过${passed} 淘汰${rejected}  ${r}`;
    }
  }
  function updateLogPanel() {
    const tab = document.querySelector(".bag-log-tab.active");
    if (tab) updateLogPanelFiltered(tab.dataset.filter || "all");
  }

  function updateLogPanelFiltered(filter) {
    const container = document.getElementById("bag-log-list");
    if (!container) return;

    // 构建: batch headers + per-candidate entries
    // 从 batchLog 和 filterLog 按时间混合显示
    let entries = filterLog.slice(-300).reverse();
    if (filter === "pass") entries = entries.filter(e => e.result === "pass");
    if (filter === "reject") entries = entries.filter(e => e.result === "reject");
    if (filter === "greet_ok") entries = entries.filter(e => e.result === "greet_ok");

    if (entries.length === 0) {
      container.innerHTML = '<div style="padding:30px;text-align:center;color:#bbb;">暂无记录</div>';
      return;
    }

    const rMap = {
      pass:    { icon:"✅", label:"通过", color:"#52c41a", bg:"#f0faf7" },
      reject:  { icon:"❌", label:"淘汰", color:"#ff4d4f", bg:"#fff5f5" },
      greet_ok:{ icon:"🤝", label:"已打招呼", color:"#00b38a", bg:"#e6fffb" },
      greet_fail:{ icon:"⚠️", label:"打招呼失败", color:"#fa8c16", bg:"#fff7e6" },
    };

    container.innerHTML = entries.map(e => {
      const r = rMap[e.result] || rMap.reject;
      const ws = e.works.map(w=>`${w.company}·${w.position}`).join(" | ");
      return `<div style="padding:8px 12px;border-bottom:1px solid #f5f5f5;background:${r.bg};line-height:1.5;">
        <div style="display:flex;justify-content:space-between;"><span style="font-weight:600;color:${r.color};font-size:12px;">${r.icon} ${e.name}</span><span style="font-size:10px;color:#bbb;">${e.time}</span></div>
        <div style="font-size:11px;color:#666;">${e.degree} · ${e.workYear}</div>
        <div style="font-size:11px;color:#888;">📋 ${ws||"无"}</div>
        <div style="font-size:11px;color:${r.color};font-weight:500;">${r.icon} ${r.label}${e.result==="reject"?`: ${e.reason}`:""}</div>
        ${e.result==="reject"?`<div style="font-size:10px;color:#999;">${e.detail}</div>`:""}
      </div>`;
    }).join("");
  }

  function createPanel() {
    GM_addStyle(`
      #bag-panel{position:fixed;top:60px;right:16px;z-index:999999;background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.16);width:380px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;font-size:13px;color:#333;user-select:none;transition:box-shadow .3s}
      #bag-panel:hover{box-shadow:0 8px 40px rgba(0,0,0,.22)}
      #bag-panel *{box-sizing:border-box}
      .bag-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:move;background:linear-gradient(135deg,#00b38a,#00c897);border-radius:14px 14px 0 0;color:#fff}
      .bag-hd-title{font-size:14px;font-weight:600}
      .bag-hd-btn{background:none;border:none;color:rgba(255,255,255,.8);font-size:18px;cursor:pointer;padding:0 4px}
      .bag-hd-btn:hover{color:#fff}
      .bag-body{padding:12px 16px;max-height:700px;overflow-y:auto;transition:max-height .3s}
      .bag-body.collapsed{max-height:0;padding:0 16px;overflow:hidden}
      .bag-row{margin-bottom:10px}
      .bag-label{font-size:12px;color:#888;margin-bottom:3px;display:flex;align-items:center;gap:4px}
      .bag-input{width:100%;padding:6px 10px;border:1px solid #e8e8e8;border-radius:6px;font-size:13px;color:#333;outline:none;transition:border .2s}
      .bag-input:focus{border-color:#00b38a}
      .bag-textarea{resize:vertical;min-height:60px;font-family:inherit;line-height:1.5}
      .bag-flex{display:flex;gap:8px;align-items:center}
      .bag-num{width:70px;text-align:center}
      .bag-btn{padding:7px 16px;border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:13px;font-weight:500;transition:opacity .15s}
      .bag-btn:hover{opacity:.85}
      .bag-toggle{background:#00b38a}
      .bag-save{background:#1677ff}
      .bag-log-btn{background:#722ed1}
      .bag-status{margin-top:8px;padding:8px 10px;background:#f6f8fa;border-radius:8px;font-size:12px;color:#666;line-height:1.6}
      .bag-stats{font-size:11px;color:#999;margin-top:4px;padding:6px 10px;background:#fafafa;border-radius:6px}
      .bag-divider{height:1px;background:#f0f0f0;margin:10px 0}
      .bag-switch{position:relative;display:inline-block;width:36px;height:20px}
      .bag-switch input{opacity:0;width:0;height:0}
      .bag-slider{position:absolute;cursor:pointer;inset:0;background:#ccc;border-radius:20px;transition:.3s}
      .bag-slider:before{content:"";position:absolute;height:16px;width:16px;left:2px;bottom:2px;background:#fff;border-radius:50%;transition:.3s}
      .bag-switch input:checked+.bag-slider{background:#00b38a}
      .bag-switch input:checked+.bag-slider:before{transform:translateX(16px)}
      #bag-current{display:none;margin-top:6px;padding:8px 10px;background:linear-gradient(135deg,#fff7e6,#fffbe6);border:1px solid #ffe58f;border-radius:8px;animation:bag-pulse-border 1.5s ease infinite}
      @keyframes bag-pulse-border{0%,100%{border-color:#ffe58f}50%{border-color:#ffa940}}
      .bag-pulse{display:inline-block;width:8px;height:8px;background:#fa8c16;border-radius:50%;animation:bag-pulse-dot 1s ease infinite}
      @keyframes bag-pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
      @keyframes bag-fade-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
      #bag-live-feed{margin-top:6px;max-height:220px;overflow-y:auto;border:1px solid #f0f0f0;border-radius:8px;padding:4px}
      .bag-live-empty{padding:16px;text-align:center;color:#ccc;font-size:12px}
      .bag-note{font-size:10px;color:#bbb;padding:4px 0;line-height:1.5}
      .bag-safety{margin-top:6px;padding:8px 10px;background:#fff7e6;border:1px solid #ffe58f;border-radius:8px;font-size:11px;color:#d46b08;line-height:1.6}
      #bag-log-modal{display:none;position:fixed;inset:0;z-index:9999999;background:rgba(0,0,0,.4);justify-content:center;align-items:center}
      #bag-log-modal.show{display:flex}
      #bag-log-inner{background:#fff;border-radius:14px;width:540px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 50px rgba(0,0,0,.3)}
      #bag-log-header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:linear-gradient(135deg,#722ed1,#9254de);border-radius:14px 14px 0 0;color:#fff}
      #bag-log-header span{font-size:15px;font-weight:600}
      #bag-log-close{background:none;border:none;color:rgba(255,255,255,.8);font-size:22px;cursor:pointer;padding:0 4px;line-height:1}
      #bag-log-close:hover{color:#fff}
      #bag-log-tabs{display:flex;border-bottom:1px solid #f0f0f0;padding:0 18px}
      .bag-log-tab{padding:10px 14px;font-size:13px;cursor:pointer;color:#999;border-bottom:2px solid transparent;transition:.2s}
      .bag-log-tab:hover{color:#333}
      .bag-log-tab.active{color:#722ed1;border-bottom-color:#722ed1;font-weight:500}
      #bag-log-list{flex:1;overflow-y:auto;min-height:200px;max-height:60vh}
    `);

    const panel = document.createElement("div");
    panel.id = "bag-panel";
    const companyStr = config.companyWhiteList.join(", ");
    const posStr = config.positionKeywords.join(", ");

    panel.innerHTML = `
      <div class="bag-hd" id="bag-hd">
        <span class="bag-hd-title">🤖 自动打招呼 v2.3</span>
        <button class="bag-hd-btn" id="bag-collapse" title="折叠/展开">—</button>
      </div>
      <div class="bag-body" id="bag-body">

        <div class="bag-row bag-flex" style="justify-content:space-between;">
          <div class="bag-flex" style="gap:6px;">
            <button class="bag-btn bag-toggle" id="bag-toggle">▶ 开始</button>
            <button class="bag-btn bag-log-btn" id="bag-log-open">📋 日志</button>
          </div>
          <span style="font-size:12px;color:#999;">今日: <b id="bag-greet-count">${getTodayGreetCount()} / ${config.maxGreetPerDay}</b></span>
        </div>

        <div class="bag-status" id="bag-status">⏸ 待启动</div>
        <div id="bag-current"></div>

        <div class="bag-note">
          💡 脚本通过独立 API 获取候选人，和页面上显示的列表可能不同。<br/>
          这是正常的——两边是独立请求，推荐算法每次返回不同结果。
        </div>

        <div id="bag-live-feed">
          <div class="bag-live-empty">启动后实时显示筛选和打招呼动态</div>
        </div>
        <div class="bag-stats" id="bag-filter-stats">过滤统计：暂无</div>

        <div class="bag-divider"></div>

        <div class="bag-safety">
          ⚠️ <b>防封建议</b>（修改下方参数）<br/>
          · 每日上限 ≤50，新号首周 ≤30<br/>
          · 打招呼间隔 ≥6s，建议 8~15s<br/>
          · 翻页间隔 ≥15s，建议 20~40s<br/>
          · 工作时间 9:00-21:00，避免凌晨<br/>
          · 避免短时间反复启停<br/>
          · 如遇验证码/弹窗，立即停止并等待 30min+
        </div>

        <div class="bag-divider"></div>

        <div class="bag-row">
          <div class="bag-label">🏢 公司白名单 <span style="color:#bbb;font-size:11px;">（逗号分隔）</span></div>
          <textarea class="bag-input bag-textarea" id="bag-companies" rows="4">${companyStr}</textarea>
        </div>
        <div class="bag-row">
          <div class="bag-label">💼 职位关键词 <span style="color:#bbb;font-size:11px;">（逗号分隔）</span></div>
          <input class="bag-input" id="bag-positions" value="${posStr}" />
        </div>
        <div class="bag-row bag-flex" style="justify-content:space-between;">
          <div class="bag-label" style="margin:0;">🎓 排除应届生</div>
          <label class="bag-switch"><input type="checkbox" id="bag-exclude-fresh" ${config.excludeFreshGraduate?"checked":""}><span class="bag-slider"></span></label>
        </div>

        <div class="bag-divider"></div>

        <div class="bag-row bag-flex" style="justify-content:space-between;">
          <div class="bag-label" style="margin:0;">📊 每日上限</div>
          <input class="bag-input bag-num" type="number" id="bag-limit" value="${config.maxGreetPerDay}" min="1" max="200" />
        </div>
        <div class="bag-row">
          <div class="bag-label">⏱ 打招呼间隔（秒）</div>
          <div class="bag-flex">
            <input class="bag-input bag-num" type="number" id="bag-delay-min" value="${(config.greetDelayMin/1000).toFixed(0)}" min="1" max="60" />
            <span style="color:#999;">~</span>
            <input class="bag-input bag-num" type="number" id="bag-delay-max" value="${(config.greetDelayMax/1000).toFixed(0)}" min="2" max="120" />
            <span style="color:#bbb;font-size:11px;">秒</span>
          </div>
        </div>
        <div class="bag-row">
          <div class="bag-label">📄 翻页间隔（秒）</div>
          <div class="bag-flex">
            <input class="bag-input bag-num" type="number" id="bag-page-min" value="${(config.pageDelayMin/1000).toFixed(0)}" min="5" max="120" />
            <span style="color:#999;">~</span>
            <input class="bag-input bag-num" type="number" id="bag-page-max" value="${(config.pageDelayMax/1000).toFixed(0)}" min="10" max="300" />
            <span style="color:#bbb;font-size:11px;">秒</span>
          </div>
        </div>
        <div class="bag-row">
          <div class="bag-label">🔑 jobId <span style="color:#bbb;font-size:11px;">（空则自动提取）</span></div>
          <input class="bag-input" id="bag-jobid" value="${config.jobId||extractJobIdFromUrl()}" placeholder="自动从URL提取" />
        </div>

        <div class="bag-divider"></div>
        <div class="bag-row" style="text-align:right;">
          <button class="bag-btn bag-save" id="bag-save">💾 保存配置</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // 日志弹窗
    const logModal = document.createElement("div");
    logModal.id = "bag-log-modal";
    logModal.innerHTML = `
      <div id="bag-log-inner">
        <div id="bag-log-header"><span>📋 筛选日志</span><button id="bag-log-close">&times;</button></div>
        <div id="bag-log-tabs">
          <div class="bag-log-tab active" data-filter="all">全部</div>
          <div class="bag-log-tab" data-filter="pass">✅ 通过</div>
          <div class="bag-log-tab" data-filter="reject">❌ 淘汰</div>
          <div class="bag-log-tab" data-filter="greet_ok">🤝 已打招呼</div>
        </div>
        <div id="bag-log-list"></div>
      </div>
    `;
    document.body.appendChild(logModal);

    panelDOM.status = document.getElementById("bag-status");
    panelDOM.filterStats = document.getElementById("bag-filter-stats");
    panelDOM.toggleBtn = document.getElementById("bag-toggle");
    panelDOM.greetCount = document.getElementById("bag-greet-count");

    panelDOM.toggleBtn.addEventListener("click", () => { applyPanelConfig(); if(isRunning)stopAutoGreet();else startAutoGreet(); });
    document.getElementById("bag-save").addEventListener("click", () => { applyPanelConfig(); saveConfig(); alert("✅ 已保存"); });

    const body = document.getElementById("bag-body");
    let collapsed = false;
    document.getElementById("bag-collapse").addEventListener("click", e => { collapsed=!collapsed; body.classList.toggle("collapsed",collapsed); e.target.textContent=collapsed?"+":"—"; });

    let curFilter = "all";
    document.getElementById("bag-log-open").addEventListener("click", () => { updateLogPanelFiltered(curFilter); logModal.classList.add("show"); });
    document.getElementById("bag-log-close").addEventListener("click", () => logModal.classList.remove("show"));
    logModal.addEventListener("click", e => { if(e.target===logModal) logModal.classList.remove("show"); });
    document.querySelectorAll(".bag-log-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".bag-log-tab").forEach(t=>t.classList.remove("active"));
        tab.classList.add("active"); curFilter=tab.dataset.filter; updateLogPanelFiltered(curFilter);
      });
    });

    makeDraggable(panel, document.getElementById("bag-hd"));
    updateToggleBtn();
  }

  function applyPanelConfig() {
    config.companyWhiteList = document.getElementById("bag-companies").value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
    config.positionKeywords = document.getElementById("bag-positions").value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
    config.excludeFreshGraduate = document.getElementById("bag-exclude-fresh").checked;
    config.maxGreetPerDay = parseInt(document.getElementById("bag-limit").value)||50;
    const dMin = parseInt(document.getElementById("bag-delay-min").value)||6;
    const dMax = parseInt(document.getElementById("bag-delay-max").value)||15;
    config.greetDelayMin = Math.max(1,dMin)*1000;
    config.greetDelayMax = Math.max(dMin+1,dMax)*1000;
    const pMin = parseInt(document.getElementById("bag-page-min").value)||15;
    const pMax = parseInt(document.getElementById("bag-page-max").value)||30;
    config.pageDelayMin = Math.max(5,pMin)*1000;
    config.pageDelayMax = Math.max(pMin+1,pMax)*1000;
    const jid = document.getElementById("bag-jobid").value.trim();
    if (jid) config.jobId = jid;
  }

  function makeDraggable(el, handle) {
    let ox=0,oy=0,dragging=false;
    handle.addEventListener("mousedown",e=>{if(e.target.tagName==="BUTTON")return;dragging=true;ox=e.clientX-el.getBoundingClientRect().left;oy=e.clientY-el.getBoundingClientRect().top;el.style.transition="none";});
    document.addEventListener("mousemove",e=>{if(!dragging)return;el.style.left=(e.clientX-ox)+"px";el.style.top=(e.clientY-oy)+"px";el.style.right="auto";});
    document.addEventListener("mouseup",()=>{dragging=false;el.style.transition="box-shadow .3s";});
  }

  // =====================================================================
  // ======================== 测试 ======================================
  // =====================================================================

  function runTests() {
    let passed=0, failed=0;
    const origConfig=config, origLog=filterLog;
    filterLog=[];
    config={...DEFAULT_CONFIG, companyWhiteList:[...DEFAULT_COMPANY_LIST], positionKeywords:["算法"], excludeFreshGraduate:true};

    function assert(n,c){if(c)passed++;else{failed++;warn(`❌ ${n}`);}}

    const mk = (name,wy,fg,works) => ({geekCard:{geekName:name,geekWorkYear:wy,freshGraduate:fg,geekDegree:"硕士",geekWorks:works,securityId:"t",lid:"t",expectId:1}});

    let v;
    v=evaluateGeek(mk("何欣雨","7年",0,[{company:"微财",positionCategory:"大模型算法"},{company:"瓴岳",positionCategory:"算法工程师"}]));
    assert("何欣雨:公司不匹配",!v.pass && v.reason==="公司不匹配");

    v=evaluateGeek(mk("应届A","25年应届生",3,[{company:"网易",positionCategory:"算法"}]));
    assert("应届生淘汰",!v.pass && v.reason==="应届生");

    v=evaluateGeek(mk("张三","5年",0,[{company:"百度",positionCategory:"搜索算法"}]));
    assert("百度+算法通过",v.pass);

    v=evaluateGeek(mk("王五","3年",0,[{company:"美团",positionCategory:"Java开发"}]));
    assert("美团+Java淘汰",!v.pass && v.reason==="职位不匹配");

    v=evaluateGeek(mk("赵六","1年",1,[{company:"腾讯",positionCategory:"推荐算法"}]));
    assert("freshGraduate=1淘汰",!v.pass && v.reason==="应届生");

    v=evaluateGeek(mk("孙七","2年",0,[{company:"智谱AI",positionCategory:"NLP算法"}]));
    assert("智谱AI通过",v.pass);

    config=origConfig; filterLog=origLog;
    log(`🧪 测试: ✅${passed} ❌${failed}`);
    return {passed,failed};
  }
  window.__BAG_RUN_TESTS = runTests;

  // ======================== 入口 ========================

  function init() {
    if (!window.location.href.includes("/web/frame")) return;
    log("BOSS自动打招呼 v2.3.0");
    createPanel();
  }

  (function bootstrap() {
    nativeFetch = window.fetch.bind(window);
    loadConfig();
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", () => setTimeout(init, randomInt(2000,4000)));
    else setTimeout(init, randomInt(2000,4000));
  })();

})();
