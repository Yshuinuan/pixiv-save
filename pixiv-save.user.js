// ==UserScript==
// @name         Pixiv 存图
// @namespace    https://github.com/Yshuinuan/pixiv-save
// @version      2.2.1
// @description  先点路径选中（高亮），再点「存当前页」把当前 Pixiv 插画或小说保存到该文件夹。插画存原图，小说存 Markdown 或纯文本。支持多路径切换。仅 Chrome / Edge 可用。
// @author       Yshuinuan
// @homepageURL  https://github.com/Yshuinuan/pixiv-save
// @supportURL   https://github.com/Yshuinuan/pixiv-save/issues
// @updateURL    https://raw.githubusercontent.com/Yshuinuan/pixiv-save/main/pixiv-save.user.js
// @downloadURL  https://raw.githubusercontent.com/Yshuinuan/pixiv-save/main/pixiv-save.user.js
// @license      MIT
// @match        https://www.pixiv.net/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      pximg.net
// @connect      i.pximg.net
// @connect      pixiv.net
// ==/UserScript==

/* eslint-disable no-console */
;(function () {
  'use strict'

  // ============================================================
  // 0. 环境自检
  // ============================================================
  const TAG = '[Pixiv存图]'
  const log = (...a) => console.log(TAG, ...a)
  const warn = (...a) => console.warn(TAG, ...a)

  if (typeof window.showDirectoryPicker !== 'function') {
    // 不静默失败，直接给用户看得见的提示
    const tip = document.createElement('div')
    tip.style.cssText =
      'position:fixed;left:16px;bottom:16px;z-index:2147483600;max-width:320px;padding:12px 14px;' +
      'background:#1e1e22;color:#ffb4b4;border:1px solid #5a2a2a;border-radius:10px;' +
      'font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)'
    tip.textContent =
      'Pixiv 存图：当前浏览器不支持 File System Access API，请改用 Chrome 或 Edge（Firefox / Safari 无法本地写入）。'
    document.body.appendChild(tip)
    return
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const uniq = (a) => [...new Set(a)]

  // ============================================================
  // 1. 设置
  // ============================================================
  const DEFAULTS = {
    template: '{id}_p{n}',
    novelTemplate: '{title}_{id}',
    novelExport: 'md', // 'md' | 'txt'
    skipExisting: true,
    saveAll: true,
    skipDeleteConfirm: false, // 用户勾了"以后不再询问"后置 true
    activeSlot: null,
    slots: [] // [{ id, name }]
  }
  const SETTINGS_KEY = 'pixiv-save:settings'

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null')
    } catch {
      return null
    }
  }

  const settings = Object.assign({}, DEFAULTS, readJSON(SETTINGS_KEY) || {})
  if (!Array.isArray(settings.slots)) settings.slots = []

  function persist() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }

  // ============================================================
  // 2. IndexedDB：目录句柄的持久化
  //    句柄可被结构化克隆，能直接存，下次免重新选择
  // ============================================================
  const DB_NAME = 'pixiv-save-db'
  const STORE = 'handles'

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function idbGet(key) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(key)
      r.onsuccess = () => resolve(r.result || null)
      r.onerror = () => reject(r.error)
    })
  }

  async function idbSet(key, val) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(val, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async function idbDel(key) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  const handleKey = (slotId) => 'slot:' + slotId

  // ============================================================
  // 3. 权限：query 与 request 必须分开
  //    requestPermission 只能在用户手势里调用
  // ============================================================
  const RW = { mode: 'readwrite' }

  /** GM_xmlhttpRequest 的 Promise 封装，统一超时与错误 */
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(
        Object.assign(
          {
            timeout: 60000,
            onload: (r) => {
              if (r.status >= 200 && r.status < 300) resolve(r)
              else reject(new Error('HTTP ' + r.status))
            },
            onerror: () => reject(new Error('网络错误')),
            ontimeout: () => reject(new Error('超时（60s）')),
            onabort: () => reject(new Error('已中止'))
          },
          opts
        )
      )
    })
  }

  async function hasPermission(handle) {
    try {
      return (await handle.queryPermission(RW)) === 'granted'
    } catch {
      return false
    }
  }

  async function requestPermission(handle) {
    try {
      return (await handle.requestPermission(RW)) === 'granted'
    } catch {
      return false
    }
  }

  // ============================================================
  // 4. 页面识别
  // ============================================================
  function getContext() {
    const href = location.href
    let m = href.match(/\/artworks\/(\d+)/)
    if (m) return { type: 'illust', id: m[1] }
    m = href.match(/[?&]illust_id=(\d+)/)
    if (m) return { type: 'illust', id: m[1] }
    m = href.match(/\/novel\/show\.php\?.*\bid=(\d+)/)
    if (m) return { type: 'novel', id: m[1] }
    m = href.match(/\/novel\/(\d+)/)
    if (m) return { type: 'novel', id: m[1] }
    return { type: 'other', id: null }
  }

  /** 主路径：pixiv 自己的 pages 接口，能一次拿到全部页的原图 */
  async function urlsFromApi(id) {
    const api = `https://www.pixiv.net/ajax/illust/${id}/pages?lang=zh`
    const res = await fetch(api, { credentials: 'include' })
    if (!res.ok) throw new Error('pages 接口返回 ' + res.status)
    const json = await res.json()
    if (json.error) throw new Error('pages 接口报错：' + (json.message || 'unknown'))
    if (!Array.isArray(json.body)) return []
    return json.body.map((it) => it.urls && it.urls.original).filter(Boolean)
  }

  /** 兜底：从 __NEXT_DATA__ 里按 id 精确挖 */
  function urlsFromNextData(id) {
    const el = document.getElementById('__NEXT_DATA__')
    if (!el) return []
    let data
    try {
      data = JSON.parse(el.textContent)
    } catch {
      return []
    }
    const found = []
    const seen = new WeakSet()
    ;(function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 12) return
      if (seen.has(node)) return
      seen.add(node)
      if (Array.isArray(node)) {
        node.forEach((v) => walk(v, depth + 1))
        return
      }
      const u = node.urls
      if (u && typeof u.original === 'string') {
        if (!id || String(node.id) === String(id)) found.push(u.original)
      }
      for (const k in node) walk(node[k], depth + 1)
    })(data, 0)
    return found
  }

  async function collectImageUrls(ctx) {
    const attempts = []

    if (ctx.type === 'illust' && ctx.id) {
      try {
        const urls = uniq(await urlsFromApi(ctx.id))
        attempts.push(`API pages → ${urls.length} 张`)
        if (urls.length) return { urls, source: 'API pages', attempts }
      } catch (e) {
        attempts.push('API pages 失败：' + e.message)
      }
    }

    const urls = uniq(urlsFromNextData(ctx.id))
    attempts.push(`__NEXT_DATA__ → ${urls.length} 张`)
    if (urls.length) return { urls, source: '__NEXT_DATA__', attempts }

    return { urls: [], source: null, attempts }
  }

  // ============================================================
  // 5. 取图
  //    实测 fetch 会被 pximg 的 CORS 策略直接掐断（Failed to fetch），
  //    而 GM_xmlhttpRequest 在扩展层发请求，不受 CORS 限制。
  //
  //    但 GM 请求仍可能因为「网络到不了 i.pximg.net」或「头部被拒」
  //    而触发 onerror（此时连 HTTP 状态码都没有）。所以这里准备多套
  //    请求方式，逐个尝试并把每种的失败原因都记下来，便于定位。
  // ============================================================

  /** 单次 GM 请求，失败时尽量把底层原因带出来 */
  function gmFetchBlobOnce(url, opts) {
    const o = opts || {}
    return new Promise((resolve, reject) => {
      const details = {
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 60000, // 原图可能 20MB+，别用短超时
        onload: (r) => {
          if (r.status >= 200 && r.status < 300 && r.response) resolve(r.response)
          else reject(new Error('HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '')))
        },
        onerror: (r) => {
          // onerror 时通常没有状态码，只能尽量抓底层信息
          const extra = (r && (r.error || r.statusText)) || ''
          reject(new Error('网络错误' + (extra ? '（' + extra + '）' : '（未收到任何 HTTP 响应）')))
        },
        ontimeout: () => reject(new Error('超时（60 秒）')),
        onabort: () => reject(new Error('已中止'))
      }
      if (o.headers) details.headers = o.headers
      if (o.fetch) details.fetch = true
      try {
        GM_xmlhttpRequest(details)
      } catch (e) {
        reject(new Error('请求无法发起：' + (e.message || e)))
      }
    })
  }

  /**
   * 多种请求方式，按"历史上成功过的"顺序排列。
   * 注意 Origin 是浏览器的受禁头部，某些版本下设置它会让整个请求失败，
   * 所以备一套不带 Origin 的方案。
   */
  const FETCH_STRATEGIES = [
    {
      name: 'GM + Referer + Origin',
      opts: { headers: { Referer: 'https://www.pixiv.net/', Origin: 'https://www.pixiv.net' } }
    },
    { name: 'GM + Referer', opts: { headers: { Referer: 'https://www.pixiv.net/' } } },
    { name: 'GM 无自定义头', opts: {} },
    {
      name: 'GM fetch 模式 + Referer',
      opts: { headers: { Referer: 'https://www.pixiv.net/' }, fetch: true }
    }
  ]

  /** 从多套方案里找一套能成功的，全失败则抛出汇总信息 */
  async function fetchBlob(url) {
    const errors = []
    for (let i = 0; i < FETCH_STRATEGIES.length; i++) {
      const s = FETCH_STRATEGIES[i]
      try {
        const blob = await gmFetchBlobOnce(url, s.opts)
        if (!blob || !blob.size) throw new Error('返回内容为空')
        // 不是第一种方案成功，说明常规路径有问题，值得记一笔
        if (i > 0) log(`⚠ 用备用方式下载成功：${s.name}`)
        return blob
      } catch (e) {
        errors.push(`${s.name} → ${e.message}`)
        log(`下载失败 [${s.name}]`, e.message)
        // 明显是网络不可达时，后面的方案大概率也一样，少等一会
        await sleep(i === 0 ? 400 : 200)
      }
    }
    throw new Error('所有请求方式均失败｜' + errors.join('｜'))
  }

  /**
   * 诊断用：在页面里找这张图对应的 <img>。
   * 返回元素说明浏览器已经能把这张图从 CDN 拉下来（naturalWidth > 0），
   * 那么下载失败就不是网络问题；返回 null 则更可能是网络/代理问题。
   */
  function probeImageInPage(url) {
    try {
      const file = String(url).split('/').pop().split('?')[0]
      const key = file.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '')
      if (!key) return null
      const imgs = document.querySelectorAll('img')
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i]
        const src = img.currentSrc || img.src || ''
        if (src && src.indexOf(key) !== -1 && img.naturalWidth > 0) return img
      }
      return null
    } catch {
      return null
    }
  }

  // ============================================================
  // 6. 文件名与落盘
  // ============================================================
  function sanitize(name) {
    return String(name)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
  }

  function extFromUrl(url) {
    let s = String(url).split('?')[0].split('#')[0]
    // pixiv 有些原图地址带 _p0.jpg 之类后缀之外的参数会在这里被截掉
    s = s.replace(/[?#].*$/, '')
    const m = s.match(/\.(jpg|jpeg|png|gif|webp)$/i)
    return m ? '.' + m[1].toLowerCase() : '.jpg'
  }

  function buildFilename(tpl, vars) {
    let name = tpl
    for (const k in vars) name = name.split('{' + k + '}').join(vars[k] == null ? '' : vars[k])
    return sanitize(name)
  }

  async function fileExists(dir, filename) {
    try {
      await dir.getFileHandle(filename)
      return true
    } catch {
      return false
    }
  }

  /** 绝不静默覆盖：同名就加 _2 _3 ... */
  async function resolveName(dir, base, ext) {
    let name = base + ext
    if (!(await fileExists(dir, name))) return name
    for (let i = 2; i <= 999; i++) {
      name = `${base}_${i}${ext}`
      if (!(await fileExists(dir, name))) return name
    }
    return `${base}_${Date.now()}${ext}`
  }

  async function writeFile(dir, filename, blob) {
    const fh = await dir.getFileHandle(filename, { create: true })
    const w = await fh.createWritable()
    await w.write(blob)
    await w.close()
  }

  // ============================================================
  // 7. 槽位（多路径）管理
  // ============================================================
  const runtime = {
    busy: false,
    slots: [] // [{ id, name, handle, granted }]，与 settings.slots 同步
  }

  function activeSlot() {
    if (!settings.activeSlot && runtime.slots.length) settings.activeSlot = runtime.slots[0].id
    return runtime.slots.find((s) => s.id === settings.activeSlot) || null
  }

  /** 从 IDB 恢复全部槽位句柄 */
  async function loadSlots() {
    runtime.slots = []
    for (const s of settings.slots) {
      const handle = await idbGet(handleKey(s.id))
      if (!handle) continue // 句柄丢了（用户清了站点数据），跳过
      const granted = await hasPermission(handle)
      runtime.slots.push({ id: s.id, name: s.name, handle, granted })
    }
    // 把已失效的槽位从设置里也清掉，避免显示幽灵条目
    settings.slots = settings.slots.filter((s) => runtime.slots.some((r) => r.id === s.id))
    if (!runtime.slots.some((s) => s.id === settings.activeSlot)) {
      settings.activeSlot = runtime.slots.length ? runtime.slots[0].id : null
    }
    persist()
  }

  /** 添加槽位：弹出系统文件夹选择窗口 */
  async function addSlot() {
    if (runtime.busy) return
    try {
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
        id: 'pixiv-save',
        startIn: 'pictures'
      })
      if (!(await requestPermission(handle))) {
        setStatus('未获得该文件夹的写入权限', 'err')
        return
      }
      // 同一个文件夹重复绑定就不再加一条
      const dup = runtime.slots.find((s) => s.handle.isSameEntry && s.name === handle.name)
      if (dup && (await dup.handle.isSameEntry(handle).catch(() => false))) {
        settings.activeSlot = dup.id
        persist()
        setStatus(`该文件夹已在列表中：${dup.name}`, 'warn')
        render()
        return
      }

      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      let name = handle.name || '未命名'
      // 同名文件夹自动加序号
      let n = 2
      const base = name
      while (runtime.slots.some((s) => s.name === name)) name = `${base} (${n++})`

      await idbSet(handleKey(id), handle)
      runtime.slots.push({ id, name, handle, granted: true })
      settings.slots.push({ id, name })
      settings.activeSlot = id
      persist()
      render()
      setStatus(`已添加：${name}（当前目标）`, 'ok')
    } catch (e) {
      if (e && e.name === 'AbortError') return // 用户取消
      setStatus('添加失败：' + (e.message || e), 'err')
    }
  }

  async function removeSlot(id) {
    const s = runtime.slots.find((x) => x.id === id)
    if (!s) return

    // 用户可以选择不再确认（懒人模式），但默认还是要确认一次，避免误删
    if (!settings.skipDeleteConfirm) {
      const r = await uiConfirm(
        `删除路径「${s.name}」？\n\n只移除绑定，磁盘上的文件不会被删。`,
        { checkbox: '以后不再询问' }
      )
      if (!r.ok) return
      if (r.checked) {
        settings.skipDeleteConfirm = true
        persist()
      }
    }

    await idbDel(handleKey(id))
    runtime.slots = runtime.slots.filter((x) => x.id !== id)
    settings.slots = settings.slots.filter((x) => x.id !== id)
    if (settings.activeSlot === id) settings.activeSlot = runtime.slots.length ? runtime.slots[0].id : null
    persist()
    render()
    const left = runtime.slots.find((x) => x.id === settings.activeSlot)
    setStatus(`已移除：${s.name}` + (left ? `　→ 当前目标：${left.name}` : '　→ 已无保存路径'), 'ok')
  }

  async function renameSlot(id) {
    const s = runtime.slots.find((x) => x.id === id)
    if (!s) return
    const v = await uiPrompt('给这个路径起个名字：', s.name)
    if (v == null) return
    const name = sanitize(v).trim()
    if (!name) return
    s.name = name
    const meta = settings.slots.find((x) => x.id === id)
    if (meta) meta.name = name
    persist()
    render()
  }

  // ============================================================
  // 8. 主流程：存当前页
  // ============================================================
  async function saveCurrentPage() {
    if (runtime.busy) {
      setStatus('正在保存中，请稍候…', 'warn')
      return
    }

    const slot = activeSlot()
    if (!slot) {
      setStatus('请先点「＋」添加一个保存路径', 'err')
      return
    }

    // 每次保存都重新确认权限：Chrome 可能在会话之间降级为 prompt
    if (!(await hasPermission(slot.handle))) {
      const ok = await requestPermission(slot.handle) // 这里在点击手势里，允许
      if (!ok) {
        slot.granted = false
        render()
        setStatus(`「${slot.name}」权限失效，请点该按钮重新授权`, 'err')
        return
      }
    }
    slot.granted = true

    const ctx = getContext()
    if (ctx.type === 'novel') {
      await handleNovel(ctx)
      return
    }
    if (ctx.type !== 'illust') {
      setStatus('当前不是作品页，请打开作品或小说页面后再存', 'err')
      return
    }

    runtime.busy = true
    setStatus('识别图片中…', 'info')

    try {
      const { urls, source, attempts } = await collectImageUrls(ctx)
      log('识别来源：', source, '| 尝试记录：', attempts)

      if (!urls.length) {
        setStatus('没识别到图片，请把控制台日志发我', 'err')
        return
      }

      const targets = settings.saveAll ? urls : urls.slice(0, 1)
      let written = 0
      let skipped = 0
      const errors = []

      for (let i = 0; i < targets.length; i++) {
        const url = targets[i]
        const base = buildFilename(settings.template, { id: ctx.id, n: i })
        const ext = extFromUrl(url)

        setStatus(`(${i + 1}/${targets.length}) 下载中…`, 'info')
        log(`下载 [${i + 1}/${targets.length}]`, url)

        // 已存在则跳过（仅当模板能一一对应时才有意义）
        if (settings.skipExisting && (await fileExists(slot.handle, base + ext))) {
          skipped++
          log('已存在，跳过：', base + ext)
          continue
        }

        // 诊断：这张图在页面上是否已经成功加载过。
        // naturalWidth > 0 说明浏览器本身能访问 i.pximg.net，
        // 那问题就出在 GM 请求上；否则是网络/代理问题。
        const probe = probeImageInPage(url)
        if (probe) log('页面内该图已加载（naturalWidth=' + probe.naturalWidth + '）→ 浏览器可访问该 CDN')

        let ok = false
        let lastErr = null
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            if (attempt) {
              log('重试第', attempt, '次：', base + ext)
              await sleep(1200)
            }
            const blob = await fetchBlob(url)
            if (!blob || !blob.size) throw new Error('返回内容为空')
            const filename = await resolveName(slot.handle, base, ext)
            await writeFile(slot.handle, filename, blob)
            written++
            ok = true
            log(`已写入 ${(blob.size / 1048576).toFixed(2)} MB →`, filename)
          } catch (e) {
            lastErr = e
          }
        }
        if (!ok) {
          const hint = !probe
            ? '（页面上这张图也没加载出来，基本可以确定是网络/代理到不了 i.pximg.net）'
            : '（页面能显示这张图，说明网络通，问题在请求本身）'
          errors.push(`${base}${ext}：${lastErr && lastErr.message}${hint}`)
        }

        await sleep(300) // 轻微限速
      }

      if (errors.length) {
        setStatus(
          `完成：写入 ${written}，跳过 ${skipped}，失败 ${errors.length}（详见控制台 F12）`,
          'err'
        )
        errors.forEach((e) => warn('失败：', e))
        warn(
          '排查提示：若提示"网络错误"，请检查代理是否覆盖 pximg.net；' +
            '若页面上图片本身就不显示，则属于网络问题而非脚本问题。'
        )
      } else {
        setStatus(`完成：写入 ${written} 张${skipped ? `，跳过 ${skipped} 张` : ''} → ${slot.name}`, 'ok')
      }
    } finally {
      runtime.busy = false
      render()
    }
  }

  // ============================================================
  // 9. 小说
  //    正文来源：/ajax/novel/{id}（GM 请求自带登录 Cookie）
  //    输出格式：.md（Markdown）或 .txt（纯文本）
  // ============================================================

  /** 把时间戳/日期字符串格式化成 YYYY-MM-DD HH:mm */
  function fmtDate(ts) {
    try {
      const d = new Date(ts)
      if (isNaN(d.getTime())) return String(ts || '')
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    } catch {
      return String(ts || '')
    }
  }

  /**
   * 从 pixiv 正文里拆出章节。
   * pixiv 的章节标记长这样：[chapter:标题]
   * 没有标记时，整篇作为一章。
   *
   * 注意：清理时只能用 trimEnd。pixiv 用全角空格（\u3000）做段落缩进，
   * String.trim() 会把它一起去掉，缩进就全丢了。
   */
  function splitChapters(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n')
    const re = /\[chapter:([^\]]*)\]/g
    const marks = []
    let m
    while ((m = re.exec(raw))) marks.push({ title: m[1].trim(), index: m.index, end: m.index + m[0].length })

    // 去掉开头的空行与尾部空白，但保留行首的全角缩进
    const cleanup = (s) => s.replace(/^\s*\n/, '').replace(/\s+$/, '')
    // 章节标题只需去掉首尾全角空格（标题不会有缩进语义）
    const cleanTitle = (s) => s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')

    if (!marks.length) return [{ title: '', text: cleanup(raw) }]

    const out = []
    // 第一个标记之前的内容并入第一章
    if (marks[0].index > 0) {
      const head = cleanup(raw.slice(0, marks[0].index))
      if (head) out.push({ title: '', text: head })
    }
    marks.forEach((mk, i) => {
      const next = i + 1 < marks.length ? marks[i + 1].index : raw.length
      out.push({
        title: cleanTitle(mk.title) || `第 ${i + 1} 章`,
        text: cleanup(raw.slice(mk.end, next))
      })
    })
    return out.filter((c) => c.text || c.title)
  }

  /** 段落缩进统一成两个全角空格（有缩进的行才处理，保持原文段首区分） */
  function normalizeIndent(line) {
    return line.startsWith('\u3000') ? line.replace(/^[\u3000\s]+/, '\u3000\u3000') : line
  }

  /** 把正文转成 Markdown：空行分段；缩进统一成两个全角空格 */
  function bodyToMarkdown(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => l.trim())
      .map(normalizeIndent)
      .join('\n\n')
  }

  /** 把正文转成纯文本：保持原换行，只规范缩进 */
  function bodyToText(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(normalizeIndent)
      .join('\n')
      .replace(/\s+$/, '')
  }

  function yamlEscape(s) {
    return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }

  /** 生成 Markdown 全文 */
  function buildNovelMarkdown(novel) {
    const chapters = splitChapters(novel.text)
    const L = []
    L.push('---')
    L.push('title: ' + yamlEscape(novel.title))
    L.push('author: ' + yamlEscape(novel.user))
    if (novel.series) L.push('series: ' + yamlEscape(novel.series))
    L.push('pixiv_id: ' + yamlEscape(novel.id))
    L.push('source: ' + yamlEscape('https://www.pixiv.net/novel/show.php?id=' + novel.id))
    if (novel.tags.length) L.push('tags: [' + novel.tags.map(yamlEscape).join(', ') + ']')
    if (novel.createDate) L.push('published: ' + yamlEscape(fmtDate(novel.createDate)))
    L.push('saved: ' + yamlEscape(fmtDate(Date.now())))
    L.push('---')
    L.push('')
    L.push('# ' + novel.title)
    L.push('')
    L.push('**作者：** ' + novel.user + '　　' + (novel.series ? '**系列：** ' + novel.series : ''))
    L.push('')

    if (chapters.length === 1 && !chapters[0].title) {
      // 没有章节标记：整篇正文直接铺开
      if (novel.coverUrl) {
        L.push('![' + novel.title + '](' + novel.coverUrl + ')')
        L.push('')
      }
      L.push(bodyToMarkdown(chapters[0].text))
    } else {
      chapters.forEach((ch, i) => {
        L.push('## ' + (ch.title || `第 ${i + 1} 章`))
        L.push('')
        L.push(bodyToMarkdown(ch.text))
        L.push('')
      })
    }
    L.push('')
    return L.join('\n')
  }

  /** 生成纯文本全文 */
  function buildNovelText(novel) {
    const chapters = splitChapters(novel.text)
    const L = []
    L.push(novel.title)
    L.push(novel.user)
    if (novel.series) L.push('系列：' + novel.series)
    if (novel.tags.length) L.push('标签：' + novel.tags.join('、'))
    L.push('https://www.pixiv.net/novel/show.php?id=' + novel.id)
    if (novel.createDate) L.push('发布：' + fmtDate(novel.createDate))
    L.push('保存：' + fmtDate(Date.now()))
    L.push('='.repeat(40))
    L.push('')
    chapters.forEach((ch, i) => {
      if (chapters.length > 1 || ch.title) {
        L.push('【' + (ch.title || `第 ${i + 1} 章`) + '】')
        L.push('')
      }
      L.push(bodyToText(ch.text))
      L.push('')
    })
    return L.join('\n')
  }

  /** 抓小说数据。GM 请求会带上 pixiv 的登录 Cookie */
  async function fetchNovel(id) {
    const api = `https://www.pixiv.net/ajax/novel/${id}`
    const r = await gmRequest({
      method: 'GET',
      url: api,
      headers: {
        Accept: 'application/json',
        Referer: `https://www.pixiv.net/novel/show.php?id=${id}`
      }
    })
    const json = JSON.parse(r.responseText)
    if (json.error) throw new Error(json.message || '接口返回错误')
    const b = json.body || {}
    const text = b.content || ''
    if (!text.trim()) {
      throw new Error('正文为空。该小说可能需要登录、已购买，或是 R-18 且未开启显示')
    }
    return {
      id: b.id || id,
      title: b.title || '无标题',
      user: (b.userName || (b.user && b.user.name)) || '未知作者',
      series: (b.seriesNavData && (b.seriesNavData.title || b.seriesNavData.seriesTitle)) || '',
      tags: (b.tags && b.tags.tags ? b.tags.tags.map((t) => t.tag) : []) || [],
      createDate: b.createDate || '',
      lang: b.language || 'ja',
      coverUrl: b.coverUrl || b.url || '',
      text,
      chapters:
        b.chapterTitles && b.chapterTitles.length
          ? [{ title: '', text }]
          : [{ title: '', text }]
    }
  }

  /** 小说页的文件名变量 */
  function buildNovelVars(ctx, novel, ext) {
    return {
      id: novel.id || ctx.id,
      title: novel.title,
      user: novel.user,
      series: novel.series,
      ext
    }
  }

  /** 剧情主干：存小说 */
  async function handleNovel(ctx) {
    const slot = activeSlot()
    if (!slot) {
      setStatus('请先点「＋」添加一个保存路径', 'err')
      return
    }

    runtime.busy = true
    setStatus('获取小说内容…', 'info')
    try {
      const novel = await fetchNovel(ctx.id)
      log('小说：', { id: novel.id, title: novel.title, user: novel.user, 字数: novel.text.length })

      const wantMd = settings.novelExport !== 'txt'
      const ext = wantMd ? '.md' : '.txt'
      const vars = buildNovelVars(ctx, novel, '')
      const base = buildFilename(settings.novelTemplate || DEFAULTS.novelTemplate, vars)

      // 已存在同名则跳过
      if (settings.skipExisting && (await fileExists(slot.handle, base + ext))) {
        setStatus(`已存在，跳过：${base + ext}`, 'warn')
        return
      }

      setStatus(wantMd ? '生成 Markdown…' : '生成纯文本…', 'info')
      const body = wantMd ? buildNovelMarkdown(novel) : buildNovelText(novel)
      const blob = new Blob([body], {
        type: wantMd ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
      })

      const filename = await resolveName(slot.handle, base, ext)
      await writeFile(slot.handle, filename, blob)
      log(`已写入 ${(blob.size / 1024).toFixed(1)} KB（${novel.text.length} 字）→`, filename)
      setStatus(`已保存：${filename}（${(blob.size / 1024).toFixed(0)} KB）→ ${slot.name}`, 'ok')
    } catch (e) {
      setStatus('小说保存失败：' + (e.message || e), 'err')
      warn('小说保存失败：', e)
    } finally {
      runtime.busy = false
      render()
    }
  }

  // ============================================================
  // 10. UI
  // ============================================================
  let panel, statusEl
  let statusKind = 'info'

  function setStatus(text, kind) {
    statusKind = kind || 'info'
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.style.color =
      statusKind === 'err'
        ? '#ff8f8f'
        : statusKind === 'ok'
          ? '#7ee787'
          : statusKind === 'warn'
            ? '#ffd479'
            : '#c8c8d0'
  }

  function render() {
    if (!panel) return
    if (!panel.querySelector('#ps-slots')) return // 面板还没渲染完，避免空引用

    const listEl = panel.querySelector('#ps-slots')
    listEl.textContent = ''

    if (!runtime.slots.length) {
      const empty = document.createElement('span')
      empty.className = 'ps-empty'
      empty.textContent = '还没有保存路径，点右边「＋」选一个文件夹'
      listEl.appendChild(empty)
    }

    runtime.slots.forEach((s) => {
      // 外壳：负责选中高亮；里面的 × 按钮负责删除
      const chip = document.createElement('div')
      chip.className = 'ps-chip' + (s.id === settings.activeSlot ? ' ps-active' : '')
      if (!s.granted) chip.classList.add('ps-nogrant')

      const label = document.createElement('span')
      label.className = 'ps-chip-label'
      label.textContent = (s.id === settings.activeSlot ? '✓ ' : '') + s.name
      chip.title =
        (!s.granted ? '⚠ 权限已失效，点一下重新授权\n' : '') +
        '单击 = 选中为目标（高亮）\n点 × = 删除这个路径\n双击 = 重命名'
      chip.appendChild(label)

      // 显式的删除按钮——右键菜单用户根本发现不了
      const del = document.createElement('button')
      del.className = 'ps-chip-del'
      del.textContent = '×'
      del.title = `删除「${s.name}」（只移除绑定，不删磁盘文件）`
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        removeSlot(s.id)
      })
      chip.appendChild(del)

      chip.addEventListener('click', async () => {
        settings.activeSlot = s.id
        persist()
        render()

        // 权限已失效时，这一下点击顺便用来重新授权（必须在用户手势里）
        if (!s.granted) {
          const ok = await requestPermission(s.handle)
          s.granted = ok
          render()
          if (!ok) {
            setStatus(`「${s.name}」仍未获得写入权限`, 'err')
            return
          }
        }
        setStatus(`已选中：${s.name}　→ 点「存当前页」开始保存`, 'info')
      })

      chip.addEventListener('dblclick', (e) => {
        e.preventDefault()
        renameSlot(s.id)
      })

      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        uiMenu(e.clientX, e.clientY, [
          { label: '重命名', run: () => renameSlot(s.id) },
          { label: '删除', run: () => removeSlot(s.id) }
        ])
      })
      listEl.appendChild(chip)
    })

    // 目标行：明确当前会存到哪里
    const targetEl = panel.querySelector('#ps-target')
    const cur = runtime.slots.find((s) => s.id === settings.activeSlot)
    if (cur) {
      targetEl.textContent = '目标：' + cur.name + (cur.granted ? '' : '（权限待确认）')
      targetEl.className = cur.granted ? 'ps-target ok' : 'ps-target warn'
    } else {
      targetEl.textContent = '目标：未选择'
      targetEl.className = 'ps-target warn'
    }

    // 模式行：当前页面是插画还是小说，按钮文案随之变化
    const ctx = getContext()
    const modeEl = panel.querySelector('#ps-mode')
    const saveBtn = panel.querySelector('#ps-save')
    if (ctx.type === 'novel') {
      modeEl.textContent = `小说模式 · ${settings.novelExport === 'txt' ? 'TXT' : 'Markdown'} · id ${ctx.id}`
      modeEl.className = 'ps-hint ps-mode-novel'
      saveBtn.textContent = '存这篇小说'
    } else if (ctx.type === 'illust') {
      modeEl.textContent = `插画模式 · id ${ctx.id}`
      modeEl.className = 'ps-hint'
      saveBtn.textContent = '存当前页'
    } else {
      modeEl.textContent = '当前不是作品页'
      modeEl.className = 'ps-hint ps-mode-warn'
      saveBtn.textContent = '存当前页'
    }
  }

  function buildUI() {
    panel = document.createElement('div')
    panel.id = 'pixiv-save-panel'
    panel.innerHTML = `
      <div id="ps-head">
        <span>Pixiv 存图</span>
        <span style="flex:1"></span>
        <span id="ps-fold" title="折叠/展开">—</span>
      </div>
      <div id="ps-body">
        <div class="ps-label">保存到</div>
        <div class="ps-slotrow">
          <div id="ps-slots"></div>
          <button id="ps-add" title="添加一个保存路径">＋</button>
        </div>
        <div class="ps-hint">① 点路径选中（变蓝高亮）　② 点「存当前页」</div>
        <div class="ps-hint">路径上的 × 可删除　·　双击路径可重命名</div>
        <div id="ps-target" class="ps-target">目标：未选择</div>
        <div id="ps-mode" class="ps-hint"></div>
        <div class="ps-row">
          <button id="ps-save" class="ps-primary">存当前页</button>
          <button id="ps-open" class="ps-ghost" title="浏览器不允许脚本打开资源管理器，这里是提示按钮">打开</button>
        </div>
        <details id="ps-adv">
          <summary>更多设置</summary>
          <div class="ps-advbody">
            <div class="ps-label">插画文件名模板</div>
            <input id="ps-tpl" spellcheck="false" />
            <div class="ps-hint">{id} 作品ID　{n} 第几页（从 0 开始）</div>
            <div class="ps-label" style="margin-top:4px">小说文件名模板</div>
            <input id="ps-ntpl" spellcheck="false" />
            <div class="ps-hint">{id} 小说ID　{title} 标题　{user} 作者　{series} 系列</div>
            <div class="ps-row" style="align-items:center">
              <span class="ps-label">小说保存格式</span>
              <select id="ps-nfmt">
                <option value="md">.md Markdown</option>
                <option value="txt">.txt 纯文本</option>
              </select>
            </div>
            <label class="ps-check"><input type="checkbox" id="ps-skip" /> 已存在则跳过</label>
            <label class="ps-check"><input type="checkbox" id="ps-all" /> 插画存全部页（否则只存第 1 张）</label>
          </div>
        </details>
        <div id="ps-status">就绪</div>
        <div class="ps-hint">快捷键 Ctrl+Shift+S</div>
      </div>
    `

    const style = document.createElement('style')
    style.textContent = `
      #pixiv-save-panel {
        position: fixed; right: 16px; bottom: 16px; width: 286px; z-index: 2147483600;
        background: #1e1e22; color: #e8e8e8; border: 1px solid #3a3a42; border-radius: 10px;
        font: 13px/1.5 "Microsoft YaHei", system-ui, sans-serif;
        box-shadow: 0 10px 32px rgba(0,0,0,.5); overflow: hidden;
      }
      #ps-head { display:flex; align-items:center; gap:6px; padding:8px 10px;
        background:#2a2a31; font-weight:600; font-size:12.5px; cursor:move; user-select:none; }
      #ps-fold { cursor:pointer; padding:0 4px; }
      #ps-body { padding:10px; display:flex; flex-direction:column; gap:8px; }
      #ps-body.ps-hidden { display:none; }
      .ps-label { font-size:11.5px; color:#8b8b96; }
      .ps-row { display:flex; gap:6px; }
      .ps-row button { flex:1; }
      .ps-slotrow { display:flex; gap:6px; align-items:flex-start; }
      #ps-slots { flex:1; display:flex; flex-wrap:wrap; gap:5px; min-height:26px; }
      #pixiv-save-panel button {
        background:#34343d; color:#e8e8e8; border:1px solid #4a4a55; border-radius:6px;
        padding:5px 10px; cursor:pointer; font:inherit; font-size:12px; white-space:nowrap;
      }
      #pixiv-save-panel button:hover { background:#41414d; }
      #pixiv-save-panel button.ps-primary { background:#0096fa; border-color:#0096fa; color:#fff; font-weight:600; }
      #pixiv-save-panel button.ps-primary:hover { background:#22a6ff; }
      #pixiv-save-panel button.ps-ghost { flex:0 0 auto; }
      .ps-chip {
        display:inline-flex; align-items:center; gap:2px; max-width:160px;
        background:#34343d; border:1px solid #4a4a55; border-radius:6px;
        padding:0 4px 0 9px; cursor:pointer; font-size:12px; user-select:none;
      }
      .ps-chip:hover { background:#41414d; }
      .ps-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:5px 0; }
      .ps-chip.ps-active {
        background:#0096fa; border-color:#7cc4ff; color:#fff; font-weight:700;
        box-shadow:0 0 0 2px rgba(0,150,250,.35);
      }
      .ps-chip.ps-active:hover { background:#22a6ff; }
      .ps-chip.ps-nogrant { border-color:#a06a2a; color:#ffd479; }
      /* 删除按钮：静默显示，悬停时变红，避免误触又保证可发现 */
      #pixiv-save-panel .ps-chip-del {
        flex:0 0 auto; background:transparent; border:none; color:inherit; opacity:.45;
        font-size:14px; line-height:1; padding:2px 4px; margin-left:1px; cursor:pointer;
        border-radius:4px;
      }
      #pixiv-save-panel .ps-chip:hover .ps-chip-del { opacity:.85; }
      #pixiv-save-panel .ps-chip-del:hover {
        background:rgba(255,80,80,.25); color:#ff8f8f; opacity:1;
      }
      .ps-chip.ps-active .ps-chip-del { color:#eaf6ff; }
      .ps-target { font-size:11.5px; color:#8b8b96; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ps-target.ok { color:#7ee787; }
      .ps-target.warn { color:#ffd479; }
      .ps-mode-novel { color:#c9a6ff !important; }
      .ps-mode-warn { color:#ffd479 !important; }
      #pixiv-save-panel select {
        background:#16161a; color:#e8e8e8; border:1px solid #4a4a55; border-radius:6px;
        padding:4px 6px; font:inherit; font-size:12px; cursor:pointer;
      }
      .ps-empty { font-size:11.5px; color:#6f6f7a; padding:5px 0; }
      #ps-add { flex:0 0 auto; padding:5px 11px; font-size:14px; line-height:1; }
      #pixiv-save-panel input:not([type=checkbox]) {
        width:100%; box-sizing:border-box; background:#16161a; border:1px solid #4a4a55; color:#e8e8e8;
        border-radius:6px; padding:5px 7px; font:12px ui-monospace, monospace;
      }
      #ps-status { font-size:12px; color:#c8c8d0; word-break:break-all; min-height:1.5em; }
      .ps-hint { font-size:11px; color:#8b8b96; line-height:1.5; }
      .ps-check { display:flex; align-items:center; gap:5px; font-size:12px; }
      #ps-adv summary { cursor:pointer; font-size:12px; color:#9a9aa5; outline:none; }
      .ps-advbody { display:flex; flex-direction:column; gap:6px; padding-top:8px; }
      #ps-menu { position:fixed; z-index:2147483601; background:#2a2a31; border:1px solid #4a4a55;
        border-radius:7px; padding:4px; min-width:110px; box-shadow:0 6px 20px rgba(0,0,0,.5); }
      #ps-menu div { padding:5px 10px; border-radius:5px; cursor:pointer; font-size:12.5px; color:#e8e8e8; }
      #ps-menu div:hover { background:#41414d; }
    `
    document.head.appendChild(style)
    document.body.appendChild(panel)

    panel.querySelector('#ps-add').addEventListener('click', addSlot)
    panel.querySelector('#ps-save').addEventListener('click', saveCurrentPage)

    panel.querySelector('#ps-open').addEventListener('click', () => {
      const s = activeSlot()
      if (!s) return setStatus('还没有保存路径', 'err')
      setStatus('浏览器不允许脚本打开资源管理器，请手动打开：' + s.name, 'warn')
    })

    panel.querySelector('#ps-tpl').addEventListener('change', (e) => {
      settings.template = e.target.value.trim() || DEFAULTS.template
      persist()
      render()
    })
    panel.querySelector('#ps-ntpl').addEventListener('change', (e) => {
      settings.novelTemplate = e.target.value.trim() || DEFAULTS.novelTemplate
      persist()
      render()
    })
    panel.querySelector('#ps-nfmt').addEventListener('change', (e) => {
      settings.novelExport = e.target.value === 'txt' ? 'txt' : 'md'
      persist()
      render()
      setStatus(`小说格式已切换为 ${settings.novelExport === 'txt' ? 'TXT' : 'Markdown'}`, 'ok')
    })
    panel.querySelector('#ps-skip').addEventListener('change', (e) => {
      settings.skipExisting = e.target.checked
      persist()
    })
    panel.querySelector('#ps-all').addEventListener('change', (e) => {
      settings.saveAll = e.target.checked
      persist()
    })
    panel.querySelector('#ps-fold').addEventListener('click', (e) => {
      const body = panel.querySelector('#ps-body')
      body.classList.toggle('ps-hidden')
      e.target.textContent = body.classList.contains('ps-hidden') ? '+' : '—'
    })

    // 拖动
    const head = panel.querySelector('#ps-head')
    let dragging = null
    head.addEventListener('mousedown', (e) => {
      dragging = { x: e.clientX, y: e.clientY, r: panel.getBoundingClientRect() }
      e.preventDefault()
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      panel.style.left = dragging.r.left + (e.clientX - dragging.x) + 'px'
      panel.style.top = dragging.r.top + (e.clientY - dragging.y) + 'px'
      panel.style.right = 'auto'
      panel.style.bottom = 'auto'
    })
    window.addEventListener('mouseup', () => (dragging = null))

    statusEl = panel.querySelector('#ps-status')
    panel.querySelector('#ps-tpl').value = settings.template
    panel.querySelector('#ps-ntpl').value = settings.novelTemplate
    panel.querySelector('#ps-nfmt').value = settings.novelExport === 'txt' ? 'txt' : 'md'
    panel.querySelector('#ps-skip').checked = settings.skipExisting
    panel.querySelector('#ps-all').checked = settings.saveAll
    render()
  }

  /** 自绘右键菜单（页面里有别的监听，用系统的容易被吃掉） */
  function uiMenu(x, y, items) {
    closeMenu()
    const menu = document.createElement('div')
    menu.id = 'ps-menu'
    items.forEach((it) => {
      const row = document.createElement('div')
      row.textContent = it.label
      row.addEventListener('click', () => {
        closeMenu()
        it.run()
      })
      menu.appendChild(row)
    })
    document.body.appendChild(menu)
    const r = menu.getBoundingClientRect()
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'
    menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px'
    setTimeout(() => {
      window.addEventListener('mousedown', closeMenu, { once: true })
      window.addEventListener('blur', closeMenu, { once: true })
    }, 0)
  }
  function closeMenu() {
    const m = document.getElementById('ps-menu')
    if (m) m.remove()
  }

  /** 自绘输入框（window.prompt 在部分环境被禁用） */
  function uiPrompt(title, def) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div')
      wrap.style.cssText =
        'position:fixed;inset:0;z-index:2147483602;background:rgba(0,0,0,.5);display:flex;' +
        'align-items:center;justify-content:center;font:13px "Microsoft YaHei",system-ui,sans-serif'
      wrap.innerHTML = `
        <div style="background:#23232a;border:1px solid #4a4a55;border-radius:10px;padding:14px;width:300px;color:#e8e8e8">
          <div style="margin-bottom:8px">${title.replace(/</g, '&lt;')}</div>
          <input id="ps-pi" style="width:100%;box-sizing:border-box;background:#16161a;border:1px solid #4a4a55;
            color:#e8e8e8;border-radius:6px;padding:6px 8px;font:13px inherit" />
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button id="ps-pc" style="background:#34343d;color:#e8e8e8;border:1px solid #4a4a55;border-radius:6px;padding:5px 12px;cursor:pointer">取消</button>
            <button id="ps-pk" style="background:#0096fa;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:600">确定</button>
          </div>
        </div>`
      document.body.appendChild(wrap)
      const input = wrap.querySelector('#ps-pi')
      input.value = def || ''
      input.focus()
      input.select()
      const done = (v) => {
        wrap.remove()
        resolve(v)
      }
      wrap.querySelector('#ps-pk').addEventListener('click', () => done(input.value))
      wrap.querySelector('#ps-pc').addEventListener('click', () => done(null))
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value)
        if (e.key === 'Escape') done(null)
      })
    })
  }

  /** 自绘确认框。返回 { ok, checked }，可选一个"不再询问"复选框 */
  function uiConfirm(text, opts) {
    const withCheckbox = !!(opts && opts.checkbox)
    return new Promise((resolve) => {
      const wrap = document.createElement('div')
      wrap.style.cssText =
        'position:fixed;inset:0;z-index:2147483602;background:rgba(0,0,0,.5);display:flex;' +
        'align-items:center;justify-content:center;font:13px "Microsoft YaHei",system-ui,sans-serif'
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')
      const cbHtml = withCheckbox
        ? `<label style="display:flex;align-items:center;gap:6px;margin-bottom:12px;font-size:12px;color:#9a9aa5;cursor:pointer">
             <input type="checkbox" id="ps-cd" /> ${opts.checkbox}
           </label>`
        : ''
      wrap.innerHTML = `
        <div style="background:#23232a;border:1px solid #4a4a55;border-radius:10px;padding:14px;width:300px;color:#e8e8e8">
          <div style="margin-bottom:12px;line-height:1.6">${safe}</div>
          ${cbHtml}
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="ps-cc" style="background:#34343d;color:#e8e8e8;border:1px solid #4a4a55;border-radius:6px;padding:5px 12px;cursor:pointer">取消</button>
            <button id="ps-ck" style="background:#c0392b;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-weight:600">删除</button>
          </div>
        </div>`
      document.body.appendChild(wrap)
      const done = (ok) => {
        const cd = wrap.querySelector('#ps-cd')
        const checked = !!(cd && cd.checked)
        wrap.remove()
        resolve({ ok, checked })
      }
      wrap.querySelector('#ps-ck').addEventListener('click', () => done(true))
      wrap.querySelector('#ps-cc').addEventListener('click', () => done(false))
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') done(false)
        if (e.key === 'Enter') done(true)
      })
    })
  }

  // ============================================================
  // 11. 快捷键 & 启动
  // ============================================================
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        // 不在输入框里才拦截
        const t = e.target
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        saveCurrentPage()
      }
    },
    true
  )

  // SPA 路由变化时提示一下当前识别到的东西
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      const c = getContext()
      log('页面变化 →', lastHref, c)
      if (panel && !runtime.busy) {
        render()
        if (c.type === 'illust') setStatus(`已识别插画 ${c.id}`, 'info')
        else if (c.type === 'novel') setStatus(`已识别小说 ${c.id}`, 'info')
        else setStatus('当前页面不是作品页', 'warn')
      }
    }
  }, 800)

  async function main() {
    buildUI()
    await loadSlots()
    render()
    const s = activeSlot()
    if (s) {
      setStatus(s.granted ? `当前目标：${s.name}` : `「${s.name}」需要重新授权，点一下该按钮`, s.granted ? 'info' : 'warn')
    } else {
      setStatus('点「＋」添加一个保存文件夹', 'info')
    }
    log('已加载。当前页面：', getContext(), '| 已有路径：', runtime.slots.map((x) => x.name))
  }

  main()
})()
