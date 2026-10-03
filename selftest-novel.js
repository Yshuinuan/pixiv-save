/**
 * 离线自检：验证小说导出（Markdown / 纯文本）的逻辑。
 *
 * 做法：把整个用户脚本丢进一个沙箱里执行（桩掉浏览器 API），
 * 然后直接调用脚本内部的函数做断言。这样测的就是真实代码，
 * 不需要用正则去"抠"函数，也不会因为字符串/正则里的括号而解析出错。
 *
 *   node selftest-novel.js
 */
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, 'pixiv-save.user.js')
let code = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '')

// 在 IIFE 内部末尾插入导出语句（源码倒数几行是 "  main()\n})()"）
const anchor = /(\r?\n)(\s*)main\(\)(\r?\n)/m
if (!anchor.test(code)) throw new Error('找不到注入锚点，脚本结构可能变了')
code = code.replace(
  anchor,
  (m, nl, indent) =>
    nl +
    indent +
    'globalThis.__T = { splitChapters, bodyToMarkdown, yamlEscape, buildNovelMarkdown, buildNovelText, fmtDate, buildFilename }' +
    nl +
    indent +
    'main()' +
    nl
)

// ---------- 浏览器 API 的桩 ----------
function fakeEl() {
  const el = {
    style: { cssText: '', setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    children: [],
    textContent: '',
    innerHTML: '',
    className: '',
    value: '',
    checked: false,
    id: '',
    setAttribute() {},
    getAttribute: () => null,
    appendChild(c) {
      this.children.push(c)
      return c
    },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    focus() {},
    select() {}
  }
  return el
}

const win = {
  showDirectoryPicker: async () => {
    throw new Error('沙箱里不应真的弹文件夹')
  },
  addEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
  location: { href: 'https://www.pixiv.net/novel/show.php?id=1111111' }
}

const doc = {
  head: fakeEl(),
  body: fakeEl(),
  createElement: () => fakeEl(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}
}

const sandbox = {
  window: win,
  document: doc,
  location: win.location,
  navigator: { userAgent: 'node-selftest' },
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] ?? null },
    setItem(k, v) { this._d[k] = String(v) },
    removeItem(k) { delete this._d[k] }
  },
  indexedDB: { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) },
  alert() {},
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  Blob,
  TextEncoder,
  TextDecoder,
  DataView,
  Uint8Array,
  Date,
  Math,
  JSON,
  Promise,
  Error,
  RegExp,
  String,
  Number,
  Array,
  Object
}

// 用 with() 让脚本里的全局引用落到沙箱对象上
const runner = new Function(
  'sandbox',
  `with (sandbox) { ${code} }\n return globalThis.__T`
)

const T = runner(sandbox)
if (!T) throw new Error('导出失败：脚本没有把函数挂到 globalThis.__T')

// ---------- 测试数据 ----------
const novelPlain = {
  id: '1111111',
  title: '没有章节的作品',
  user: '作者A',
  series: '',
  tags: ['标签1', '标签2'],
  createDate: '2026-10-01T12:00:00+09:00',
  coverUrl: 'https://i.pximg.net/c/240x480/img-master/img/2026/10/01/12/00/00/1111111_p0_master1200.jpg',
  text: '第一段。\n\u3000第二段有缩进。\n\n\n第三段。'
}

const novelChapters = {
  id: '2222222',
  title: '有章节的作品',
  user: '作者B',
  series: '系列名',
  tags: [],
  createDate: '',
  coverUrl: '',
  text: '前言部分。\n[chapter:第一章 起始]\n\u3000第一章正文。\n[chapter:第二章 转折]\n第二章正文。'
}

const novelWeird = {
  id: '3333333',
  title: '标题里有 "引号" 和 \\ 反斜杠',
  user: '作者C',
  series: '',
  tags: [],
  createDate: '',
  coverUrl: '',
  text: '   \n\n  '
}

// ---------- 断言 ----------
let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) {
    pass++
    console.log('[OK ] ' + label)
  } else {
    fail++
    console.log('[FAIL] ' + label + (extra ? '  → ' + extra : ''))
  }
}

console.log('=== 1. 章节拆分 ===')
{
  const c1 = T.splitChapters(novelPlain.text)
  check('无章节标记时只有一章', c1.length === 1, '实际 ' + c1.length)
  check('无标记时 title 为空', c1[0].title === '')

  const c2 = T.splitChapters(novelChapters.text)
  check('识别出 3 段（前言 + 2 章）', c2.length === 3, '实际 ' + c2.length)
  check('第一章标题正确', c2[1] && c2[1].title === '第一章 起始', c2[1] && c2[1].title)
  check('第二章标题正确', c2[2] && c2[2].title === '第二章 转折', c2[2] && c2[2].title)
  check('前言被单独保留', c2[0] && c2[0].text.includes('前言部分'))
  check('章节标记本身不出现在正文里', !c2[1].text.includes('[chapter:'))
  check('第一章正文保留全角缩进', c2[1].text === '\u3000第一章正文。', JSON.stringify(c2[1].text))
}

console.log('\n=== 2. Markdown 生成 ===')
{
  const md = T.buildNovelMarkdown(novelPlain)
  check('含 YAML front matter 起始', md.startsWith('---\n'))
  check('含 title 字段', /^title: "没有章节的作品"$/m.test(md))
  check('含 author 字段', /^author: "作者A"$/m.test(md))
  check('含 pixiv_id 字段', /^pixiv_id: "1111111"$/m.test(md))
  check('含 source 链接', md.includes('https://www.pixiv.net/novel/show.php?id=1111111'))
  check('tags 是 YAML 数组', /^tags: \["标签1", "标签2"\]$/m.test(md))
  check('含一级标题', md.includes('# 没有章节的作品'))
  check('含封面图片语法', md.includes('![') && md.includes('pximg.net'))
  check('正文段落被空行分隔', md.includes('第一段。\n\n'))
  check('缩进行被规范成两个全角空格', md.includes('\u3000\u3000第二段有缩进。'))
  check('无缩进行保持不缩进', md.includes('\n第一段。\n'))
  check('没有三个以上连续换行', !md.includes('\n\n\n\n'))

  const mdChap = T.buildNovelMarkdown(novelChapters)
  check('章节正文的缩进也被规范化', mdChap.includes('\u3000\u3000第一章正文。'))

  const txtChap = T.buildNovelText(novelChapters)
  check('纯文本里缩进同样是两个全角空格', txtChap.includes('\u3000\u3000第一章正文。'))

  const md2 = T.buildNovelMarkdown(novelChapters)
  check('有章节时生成二级标题', md2.includes('## 第一章 起始') && md2.includes('## 第二章 转折'))
  check('有章节时不插入封面', !md2.includes('!['))
  check('series 写入 front matter', /^series: "系列名"$/m.test(md2))
}

console.log('\n=== 3. YAML 转义（防止 front matter 被破坏）===')
{
  const md = T.buildNovelMarkdown(novelWeird)
  const titleLine = md.split('\n').find((l) => l.startsWith('title:'))
  check('标题里的引号被转义', titleLine.includes('\\"'), titleLine)
  check('反斜杠被转义', titleLine.includes('\\\\'), titleLine)

  const fmEnd = md.indexOf('\n---\n', 4)
  check('front matter 能被正确闭合', fmEnd > 0)
  const fm = md.slice(4, fmEnd)
  const badLine = fm.split('\n').find((l) => l && !/^[a-z_]+: /.test(l))
  check('front matter 每行都是合法 key: value', !badLine, badLine)
}

console.log('\n=== 4. 纯文本生成 ===')
{
  const txt = T.buildNovelText(novelPlain)
  check('首行是标题', txt.split('\n')[0] === '没有章节的作品')
  check('第二行是作者', txt.split('\n')[1] === '作者A')
  check('含标签行', txt.includes('标签：标签1、标签2'))
  check('含分隔线', txt.includes('='.repeat(40)))
  check('含正文', txt.includes('第一段。'))
  check('没有 Markdown 语法残留', !txt.includes('# 没有章节'))

  const txt2 = T.buildNovelText(novelChapters)
  check('多章时带章节标题标记', txt2.includes('【第一章 起始】') && txt2.includes('【第二章 转折】'))
  check('前言部分保留', txt2.includes('前言部分。'))
}

console.log('\n=== 5. 边界情况 ===')
{
  check('空正文生成 Markdown 不抛异常', typeof T.buildNovelMarkdown(novelWeird) === 'string')
  check('空正文生成纯文本不抛异常', typeof T.buildNovelText(novelWeird) === 'string')
  check('空正文 Markdown 仍有标题', T.buildNovelMarkdown(novelWeird).includes('# 标题里有'))

  // 文件名模板
  check('模板 {title}_{id}', T.buildFilename('{title}_{id}', { title: 'abc', id: '9' }) === 'abc_9')
  check('文件名非法字符被替换', T.buildFilename('{title}', { title: 'a/b:c?d*e' }) === 'a_b_c_d_e')
}

console.log('\n' + '='.repeat(46))
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log(fail === 0 ? '结论：全部通过 ✓' : '结论：存在问题 ✗')
process.exit(fail === 0 ? 0 : 1)
