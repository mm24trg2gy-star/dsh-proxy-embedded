/**
 * dsh-proxy-embedded — 浏览器半部（设置页「内嵌代理」）
 *
 * 手写 ModuleLoader bundle，无需构建：
 *   window.__ModuleLoader__.load({ id, factory })
 * id 必须等于 loader entry 名（dsh-proxy-embedded）。
 *
 * 这里发的是同源 fetch，浏览器会带上 DSH 的登录 cookie，所以能通过宿主准入；
 * 直接在地址栏打开插件路由则不会（那是裸导航），这正是我们要的行为。
 */
window.__ModuleLoader__.load({
  id: 'dsh-proxy-embedded',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var ROUTE = '/proxy-embedded/api'

    var styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0', color: 'inherit' },
      card: { border: '1px solid rgba(128,128,128,0.3)', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      hint: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      dot: function (on) {
        return { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: on ? '#22c55e' : '#9ca3af' }
      },
      btn: { border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer', fontSize: '13px' },
      input: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit', fontSize: '13px', boxSizing: 'border-box' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' }
    }

    function describe(result) {
      if (result && result.error) return String(result.error.message || result.error.code || '操作失败')
      return ''
    }

    function useProxy() {
      var state = react.useState(null)
      var data = state[0]
      var setData = state[1]
      var busyState = react.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errState = react.useState('')
      var error = errState[0]
      var setError = errState[1]
      var seqRef = react.useRef(0)

      function call(body) {
        return fetch(ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body || {})
        })
          .then(function (r) {
            var type = (r.headers.get('content-type') || '').toLowerCase()
            if (r.status === 401) {
              return { ok: false, error: { code: 'unauthorized', message: 'DSH 会话未通过准入（401）：刷新 DSH 页面后重试' } }
            }
            if (!r.ok) {
              return { ok: false, error: { code: 'http-' + r.status, message: '宿主返回 HTTP ' + r.status + (type ? '（' + type + '）' : '') } }
            }
            if (type.indexOf('application/json') === -1) {
              return { ok: false, error: { code: 'not-json', message: '宿主响应不是 JSON：' + (type || '无 content-type') } }
            }
            return r.json()
          })
          .catch(function (e) { return { ok: false, error: { message: String((e && e.message) || e) } } })
      }

      function run(body) {
        seqRef.current += 1
        var mine = seqRef.current
        setBusy(true)
        return call(body).then(function (j) {
          if (mine !== seqRef.current) return j // 旧响应，丢弃
          if (j && j.ok === false) setError(describe(j))
          else if (j && j.value) { setData(j.value); setError('') }
          setBusy(false)
          return j
        })
      }

      function refresh() { return run({ action: 'status' }) }

      react.useEffect(function () { refresh() }, [])
      return { data: data, busy: busy, error: error, refresh: refresh, act: run }
    }

    function Row(props) {
      return h('div', { style: styles.row }, props.children)
    }

    function Panel() {
      var p = useProxy()
      var d = p.data
      var phase = d ? d.phase : ''
      var running = phase === 'ready'
      var phaseText = {
        ready: '代理就绪',
        importing: '正在导入订阅…',
        stopped: '已停止',
        error: '启动失败',
        'core-only': '内核在跑，但宿主路由未装上'
      }[phase] || (phase || '正在读取…')

      var linkState = react.useState('')
      var link = linkState[0]
      var setLink = linkState[1]

      var savedText = d && d.hasLink ? ('已保存：' + (d.linkMask || '（已保存）')) : '还没有保存订阅链接'

      function start() {
        var value = link.trim()
        if (!value) return
        p.act({ action: 'start', link: value }).then(function (j) {
          // 只有确认启动成功才清空输入，失败时保留让用户直接重试
          if (j && j.ok !== false) setLink('')
        })
      }

      return h('div', { style: styles.wrap },
        h('div', { style: styles.card },
          h(Row, null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: styles.dot(running) }),
              h('strong', null, phaseText)
            ),
            h('button', { style: styles.btn, disabled: p.busy, onClick: p.refresh }, '刷新')
          ),
          h(Row, null,
            h('span', { style: styles.hint }, '本地端口'),
            h('span', { style: styles.mono }, d && d.port ? String(d.port) : '—')
          ),
          h(Row, null,
            h('span', { style: styles.hint }, '订阅格式 / 节点数'),
            h('span', { style: styles.mono }, d && d.format ? (d.format + ' · ' + (d.nodeCount || 0)) : '—')
          ),
          h(Row, null,
            h('span', { style: styles.hint }, '宿主出站接管'),
            h('span', { style: styles.mono }, d && d.route && d.route.proxied ? '已接管' : '未接管')
          ),
          h(Row, null,
            h('span', { style: styles.hint }, '内核'),
            h('span', { style: styles.mono }, d && d.kernel ? d.kernel : (d && d.kernelFound ? '已找到' : '未找到'))
          ),
          d && d.message ? h('div', { style: styles.hint }, d.message) : null
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.hint }, savedText),
          h('input', {
            style: styles.input,
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: '粘贴 Clash / V2Ray / Shadowrocket / sing-box / Surge 订阅链接',
            value: link,
            disabled: p.busy,
            onChange: function (e) { setLink(e.target.value) }
          }),
          h('div', { style: styles.hint }, '链接只在本机使用，页面不会回显已保存的完整地址。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            h('button', { style: styles.btn, disabled: p.busy || !link.trim(), onClick: start }, '启动代理'),
            h('button', { style: styles.btn, disabled: p.busy, onClick: function () { p.act({ action: 'stop' }) } }, '停止'),
            h('button', { style: styles.btn, disabled: p.busy, onClick: function () { p.refresh() } }, '重新读取状态')
          )
        ),

        p.error ? h('div', { style: { color: '#ef4444', fontSize: '12px' } }, p.error) : null,

        h('div', { style: styles.hint },
          '入口受 DSH 准入保护：本面板通过 DSH 页面内的同源请求访问；地址栏直开、本机 curl 或不满足宿主准入条件的请求会被拒绝。订阅只提供节点，策略与监听由插件生成。')
      )
    }

    var inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'proxy-embedded', order: 26, label: '内嵌代理' },
          function () { return h(Panel, {}) }
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
