
    /** Locale namespace owned by this bundle. */
    const NS = 's2s-history'

    /** Sidebar footer action id. */
    const SLOT_ID = 's2s-history'

    /** localStorage key holding the panel's open/closed state. */
    const OPEN_KEY = 'dsh-s2s:history-open'

    /** localStorage key holding the subagent-row visibility flag. */
    const SUBAGENT_KEY = 'dsh-s2s:history-subagents'

    /** localStorage key holding the active panel tab. */
    const TAB_KEY = 'dsh-s2s:history-tab'

    /**
     * Conversations read per feed batch.
     *
     * Each read is one host round-trip that loads and folds that conversation's
     * whole log, so the feed pages deliberately: a confident first screen beats
     * a long blank one. The host route caps a request at the same number.
     */
    const FEED_BATCH = 8

    /**
     * Read-only host route serving message records for a batch of sessions.
     *
     * It sits INSIDE the framework's `/api` prefix, so the shared handler has
     * already applied its trust fence and browser-session authentication by the
     * time the host half answers — the page reaches it with the same same-origin
     * cookie every other API call uses.
     */
    const ROUTE = '/api/s2s-history/messages'

    /** Marker thrown when the route itself is absent (host half not mounted). */
    const HOST_ABSENT = 's2s-history-host absent'

    /** Hard cap on rendered messages; the filter runs over everything read. */
    const FEED_RENDER_LIMIT = 400

    /**
     * How often the open feed re-reads the conversations it already holds.
     *
     * The host half caches each conversation for a few seconds, so polling
     * faster than that only re-reads the cache; this is the interval at which
     * new traffic can actually appear.
     */
    const FEED_REFRESH_MS = 5_000

    /** Per-message body cap. One huge tool dump must not bury the conversation. */
    const FEED_BODY_LIMIT = 1200

    /**
     * Body length past which a row offers "expand".
     *
     * The body is always rendered in full and clipped by CSS; this only decides
     * whether the expand control is worth showing. Set well under the render
     * clip so the control appears before a body becomes an unreadable wall.
     */
    const FEED_BODY_PREVIEW = 220

    /** Event types whose payload is a message the feed can show. */
    const MESSAGE_EVENT_TYPES = {
      'user/message': 'user',
      'assistant/message': 'assistant',
    }

    const MINUTE = 60 * 1000
    const HOUR = 60 * MINUTE
    const DAY = 24 * HOUR

    const zh = {
      'action.open': '会话历史',
      'action.tip': '按工作区查看会话，只引用不展开',
      'panel.title': '会话历史',
      'panel.subtitle': '只引用对话，不显示消息正文',
      'panel.close': '关闭',
      'panel.empty': '没有可显示的会话',
      'panel.otherGroups': '其他工作区',
      'panel.count': '{n} 个会话',
      'panel.running': '{n} 运行中',
      'row.current': '当前',
      'row.open': '未结束',
      'row.done': '已完成',
      'row.blank': '新会话',
      'row.subagent': '子代理',
      'panel.sort': '按最近提问排序',
      'panel.stray': '未归入工作区',
      'panel.showSubagents': '含子代理',
      'panel.hint': '点击任意一行即可回到该会话继续。',
      'tab.index': '索引',
      'tab.messages': '消息',
      'feed.idle': '切到「消息」页签即开始读取。',
      'feed.loading': '正在读取 {n} 个会话…',
      'feed.loaded': '已读 {s} 个会话 · {m} 条消息 · 显示 {n} 条',
      'feed.more': '再读 {n} 个会话',
      'feed.refresh': '重新读取',
      'feed.save': '另存',
      'feed.saved': '已导出为 JSON 文件',
      'feed.search': '搜索会话名 / 正文',
      'feed.clear': '清空',
      'feed.none': '没有匹配的消息',
      'feed.role.user': '提问',
      'feed.role.assistant': '回复',
      'feed.role.s2s': 's2s',
      'feed.from': '来自 {who}',
      'feed.truncated': '（正文过长，此处截断显示）',
      'feed.capped': '（已达 {n} 条显示上限，下面的会话未显示）',
      'feed.expand': '展开全文',
      'feed.collapse': '收起',
      'feed.workspace': '工作区',
      'feed.allWorkspaces': '全部工作区',
      'feed.s2sOnly': '只看 s2s',
      'feed.count': '{n} 条',
      'feed.noroute': '读取消息正文需要宿主半边 s2s-history-host（重启 dsh web 后生效）；索引页签不受影响。',
      'feed.failed': '读取失败：{why}',
      'feed.retry': '重试',
    }

    const en = {
      'action.open': 'Session history',
      'action.tip': 'Conversations by workspace — quoted, never expanded',
      'panel.title': 'Session history',
      'panel.subtitle': 'Conversations are quoted, not shown',
      'panel.close': 'Close',
      'panel.empty': 'No conversations to show',
      'panel.otherGroups': 'Other workspaces',
      'panel.count': '{n} conversations',
      'panel.running': '{n} running',
      'row.current': 'current',
      'row.open': 'open',
      'row.done': 'done',
      'row.blank': 'new',
      'row.subagent': 'subagent',
      'panel.sort': 'By last prompt',
      'panel.stray': 'Not in a workspace',
      'panel.showSubagents': 'Subagents',
      'panel.hint': 'Click any row to go back to that conversation.',
      'tab.index': 'Index',
      'tab.messages': 'Messages',
      'feed.idle': 'Switch to Messages to start reading.',
      'feed.loading': 'Reading {n} conversations…',
      'feed.loaded': '{s} conversations · {m} messages · showing {n}',
      'feed.more': 'Read {n} more',
      'feed.refresh': 'Reload',
      'feed.save': 'Save as',
      'feed.saved': 'Exported as a JSON file',
      'feed.search': 'Search titles / bodies',
      'feed.clear': 'Clear',
      'feed.none': 'No matching messages',
      'feed.role.user': 'ask',
      'feed.role.assistant': 'reply',
      'feed.role.s2s': 's2s',
      'feed.from': 'from {who}',
      'feed.truncated': '(body truncated here)',
      'feed.capped': '({n}-message display cap reached; later conversations are not shown)',
      'feed.expand': 'Show all',
      'feed.collapse': 'Collapse',
      'feed.workspace': 'Workspace',
      'feed.allWorkspaces': 'All workspaces',
      'feed.s2sOnly': 's2s only',
      'feed.count': '{n}',
      'feed.noroute': 'Reading message bodies needs the host half (s2s-history-host); restart dsh web to mount it. The Index tab is unaffected.',
      'feed.failed': 'Read failed: {why}',
      'feed.retry': 'Retry',
    }

    /**
     * Substitute `{name}` placeholders in one dictionary entry.
     * @param {string} template - dictionary text.
     * @param {object} [values] - placeholder values.
     * @returns {string} rendered text.
     */
    function fill(template, values) {
      if (!values) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match)
    }

    /**
     * Relative age of an epoch-ms instant.
     * @param {number} at - instant in epoch ms.
     * @param {number} now - current instant in epoch ms.
     * @returns {string} a short age.
     */
    function ageOf(at, now) {
      const delta = Math.max(0, now - at)
      if (delta < MINUTE) return 'now'
      if (delta < HOUR) return Math.floor(delta / MINUTE) + 'm'
      if (delta < DAY) return Math.floor(delta / HOUR) + 'h'
      return Math.floor(delta / DAY) + 'd'
    }

    /**
     * Short display form of a session id: the uuid part, first 8 characters.
     * @param {string} id - canonical session id.
     * @returns {string} short form.
     */
    function shortId(id) {
      return String(id === undefined || id === null ? '' : id).replace(/^session-/, '').slice(0, 8)
    }

    /**
     * Two-digit zero pad.
     * @param {number} value - small non-negative integer.
     * @returns {string} padded text.
     */
    function pad(value) {
      return value < 10 ? '0' + value : String(value)
    }

    /**
     * Absolute local wall-clock stamp for an epoch-ms instant.
     *
     * Relative age alone cannot answer "when was I last here" across days, and
     * the instant is already local-time on the user's own machine, so no
     * timezone conversion is involved: the epoch value is rendered through the
     * browser's own local time zone.
     * @param {number} at - instant in epoch ms.
     * @returns {string} `MM-DD HH:mm`, or '' for a missing instant.
     */
    function localStamp(at) {
      if (typeof at !== 'number' || at <= 0) return ''
      const date = new Date(at)
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /**
     * Basename of a workspace directory path.
     * @param {string} path - absolute directory path.
     * @returns {string} display label.
     */
    function baseName(path) {
      if (typeof path !== 'string' || path.length === 0) return ''
      const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts[parts.length - 1] || path
    }

    /**
     * Coarse conversation state from list metadata alone.
     * @param {object} summary - session list row.
     * @returns {string} one of running | done | idle.
     */
    function stateOf(summary) {
      if (summary.running) return 'running'
      if (summary.completed === true) return 'done'
      return 'idle'
    }

    /**
     * Whether one row belongs in the index.
     *
     * Mirrors the framework browser's own visibility rule
     * (ui-workspace `sessionVisible`): subagent children are not conversations
     * a user resumes, archived sessions are hidden, and a blank session is only
     * the current one's provisional New Session row. Keeping the same rule
     * means this panel and the sidebar never disagree about what exists.
     * @param {object} summary - session list row.
     * @param {string|undefined} current - current session id.
     * @param {Set<string>} archived - archived session ids.
     * @param {boolean} showSubagents - whether subagent children are listed.
     * @returns {boolean} whether the row is visible.
     */
    function sessionVisible(summary, current, archived, showSubagents) {
      if (summary.origin === 'subagent' && !showSubagents) return false
      if (archived.has(summary.id)) return false
      if (summary.blank === true && summary.id !== current) return false
      return true
    }

    /**
     * Group the session list by workspace from browser-resident state.
     *
     * Membership follows `workspace.sessionIds` (the manual order account);
     * sessions no account claims fall back to `cwd` matching, so a conversation
     * can never appear under two workspaces. The current session's workspace is
     * placed first — the panel exists to show where the user stopped, so their
     * own workspace leads regardless of registry order.
     * @param {object} list - sessions list snapshot.
     * @param {object} workspaceSnapshot - workspaces snapshot.
     * @param {object} [options] - { showSubagents }.
     * @returns {Array<object>} groups, each with rows newest-first.
     */
    function buildGroups(list, workspaceSnapshot, options) {
      const showSubagents = Boolean(options && options.showSubagents)
      const archivedIds = (workspaceSnapshot && workspaceSnapshot.archivedSessionIds) || []
      const archived = new Set(archivedIds)
      const items = (workspaceSnapshot && workspaceSnapshot.items) || []
      const ids = (list && list.ids) || []
      const byId = (list && list.byId) || {}
      const current = list && list.current
      const claimed = new Set()
      const groups = []

      for (const workspace of items) {
        const members = []
        for (const memberId of workspace.sessionIds || []) {
          const member = byId[memberId]
          if (member === undefined) continue
          claimed.add(memberId)
          if (!sessionVisible(member, current, archived, showSubagents)) continue
          members.push(member)
        }
        groups.push({
          key: workspace.workspaceId,
          label: workspace.title || baseName(workspace.path),
          path: workspace.path,
          sessions: members,
          running: 0,
          current: false,
        })
      }

      const stray = []
      for (const id of ids) {
        if (claimed.has(id)) continue
        const summary = byId[id]
        if (summary === undefined) continue
        if (!sessionVisible(summary, current, archived, showSubagents)) continue
        let placed = false
        for (const group of groups) {
          if (group.path !== undefined && summary.cwd === group.path) {
            group.sessions.push(summary)
            placed = true
            break
          }
        }
        if (!placed) stray.push(summary)
      }
      if (stray.length > 0) {
        groups.push({ key: '__ungrouped__', label: '', path: undefined, sessions: stray, running: 0, current: false })
      }

      // Newest activity first inside every group: the panel exists to show
      // where things stopped, so the most recent conversation leads. Id is the
      // tiebreak so the order is total and stable frame to frame.
      for (const group of groups) {
        group.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
          || (a.id < b.id ? -1 : 1))
        group.running = group.sessions.filter(row => row.running).length
        group.current = current !== undefined && group.sessions.some(row => row.id === current)
      }

      // Current workspace first, ungrouped last, everything else in registry order.
      //
      // The two selections are exclusive BY CONSTRUCTION: when the current
      // session is itself ungrouped (a freshly continued conversation that no
      // workspace account claims yet — the normal state of the session you are
      // working in), `currentGroup` and the ungrouped group are the SAME object.
      // Emitting both put that group in the list twice, and because the feed
      // queues one read per group membership, every conversation in it was read
      // twice and rendered twice. So the hoist takes priority and the ungrouped
      // tail skips whatever the hoist already emitted.
      const currentGroup = groups.find(group => group.current)
      const ungrouped = groups.filter(group =>
        group.key === '__ungrouped__' && group !== currentGroup)
      const rest = groups.filter(group => group !== currentGroup && group.key !== '__ungrouped__')
      return [
        ...(currentGroup === undefined ? [] : [currentGroup]),
        ...rest,
        ...ungrouped,
      ]
    }

    /** Install the panel's stylesheet once. */
    function installStyles() {
      const id = 'dsh-s2s-history-style'
      if (document.getElementById(id) !== null) return
      const style = document.createElement('style')
      style.id = id
      style.textContent = [
        '.s2s-h-action{display:flex;align-items:center;gap:8px;width:100%;}',
        // The overlay is portaled to <body> (see HistoryPanel) because the
        // sidebar column creates a fixed-positioning containing block whenever
        // the wallpaper plugin turns on its glass recipe (backdrop-filter on
        // [data-dsh-sidebar-col]) — an un-portaled fixed layer would then be
        // sized and clipped by the sidebar instead of the viewport. z-index
        // sits in the framework's overlay band (Modal 1000, Toast 1100).
        '.s2s-h-root{position:fixed;inset:0;z-index:1000;display:flex;justify-content:flex-end;}',
        '.s2s-h-mask{position:absolute;inset:0;background:rgba(0,0,0,.28);}',
        '.s2s-h-panel{position:relative;display:flex;flex-direction:column;height:100%;',
        // Surface and text come from the framework's own alias tokens. The
        // names here used to be `--dsh-surface` / `--dsh-text`, which DO NOT
        // EXIST anywhere in the framework — its palette is `--dsw-alias-*`
        // (see ui-theme/src/styles/design-platform.css). A missing custom
        // property falls back silently, so the panel was pinned to the dark
        // literals below in EVERY theme while the rest of the app followed the
        // user's choice — and the native dropdown popup, which does follow the
        // theme, then disagreed with the panel it opened from.
        'width:min(480px,92vw);background:var(--dsw-alias-bg-layer-2,var(--dsh-surface,#1b1b1f));',
        'color:var(--dsw-alias-label-primary,var(--dsh-text,#e6e6e6));',
        'border-left:1px solid rgba(128,128,128,.25);',
        'box-shadow:-8px 0 32px rgba(0,0,0,.35);}',
        '.s2s-h-head{display:flex;align-items:flex-start;gap:8px;padding:14px 16px;',
        'border-bottom:1px solid rgba(128,128,128,.2);}',
        '.s2s-h-title{font-size:14px;font-weight:600;}',
        '.s2s-h-sub{font-size:11px;opacity:.6;margin-top:2px;}',
        '.s2s-h-close{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;',
        'font-size:16px;line-height:1;padding:2px 6px;border-radius:4px;}',
        '.s2s-h-close:hover{background:rgba(128,128,128,.18);}',
        '.s2s-h-body{flex:1;overflow-y:auto;padding:8px 0 16px;}',
        '.s2s-h-ghead{display:flex;align-items:baseline;gap:8px;padding:6px 16px;font-size:11px;',
        'text-transform:uppercase;letter-spacing:.04em;opacity:.7;}',
        '.s2s-h-gcount{font-size:10px;opacity:.7;text-transform:none;letter-spacing:0;}',
        '.s2s-h-row{display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;border:0;',
        'background:transparent;color:inherit;cursor:pointer;padding:7px 16px;font:inherit;}',
        '.s2s-h-row:hover{background:rgba(128,128,128,.14);}',
        '.s2s-h-row[data-current="true"]{background:rgba(120,170,255,.14);}',
        '.s2s-h-dot{width:6px;height:6px;border-radius:50%;margin-top:6px;flex:0 0 auto;background:#6b6b6b;}',
        '.s2s-h-dot[data-state="running"]{background:#43c26b;}',
        '.s2s-h-dot[data-state="done"]{background:#d8a13a;}',
        '.s2s-h-main{min-width:0;flex:1;}',
        '.s2s-h-t{display:block;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.s2s-h-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:10.5px;opacity:.62;margin-top:2px;}',
        '.s2s-h-sid{font-family:ui-monospace,Consolas,monospace;}',
        '.s2s-h-tag{border:1px solid rgba(128,128,128,.4);border-radius:3px;padding:0 4px;}',
        '.s2s-h-foot{display:flex;gap:8px;align-items:center;padding:8px 16px;font-size:10.5px;',
        'opacity:.55;border-top:1px solid rgba(128,128,128,.2);}',
        '.s2s-h-sort{margin-left:auto;white-space:nowrap;}',
        '.s2s-h-toggle{display:inline-flex;align-items:center;gap:5px;cursor:pointer;}',
        '.s2s-h-toggle input{margin:0;}',
        '.s2s-h-stamp{font-variant-numeric:tabular-nums;}',
        '.s2s-h-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid rgba(128,128,128,.2);}',
        '.s2s-h-tab{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;',
        'font-size:12px;padding:7px 10px;border-bottom:2px solid transparent;opacity:.65;}',
        '.s2s-h-tab:hover{opacity:.9;}',
        '.s2s-h-tab[data-active="true"]{opacity:1;border-bottom-color:currentColor;font-weight:600;}',
        '.s2s-h-tools{display:flex;gap:6px;align-items:center;padding:8px 12px;',
        'border-bottom:1px solid rgba(128,128,128,.14);}',
        '.s2s-h-search{flex:1;min-width:0;font:inherit;font-size:12px;padding:5px 8px;border-radius:5px;',
        'border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.1);color:inherit;}',
        '.s2s-h-btn{font:inherit;font-size:11px;padding:5px 9px;border-radius:5px;cursor:pointer;',
        'border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.1);color:inherit;white-space:nowrap;}',
        '.s2s-h-btn:hover:enabled{background:rgba(128,128,128,.2);}',
        '.s2s-h-btn:disabled{opacity:.5;cursor:default;}',
        '.s2s-h-note{padding:10px 16px;font-size:11.5px;opacity:.68;line-height:1.5;}',
        '.s2s-h-bad{color:#e0757a;}',
        '.s2s-h-session{margin:10px 0 14px;border-top:1px solid rgba(128,128,128,.18);padding-top:4px;}',
        '.s2s-h-session:first-child{border-top:0;}',
        '.s2s-h-shead{display:flex;align-items:baseline;gap:8px;padding:6px 16px 5px;',
        'background:rgba(128,128,128,.08);position:sticky;top:0;z-index:1;',
        'backdrop-filter:blur(4px);}',
        '.s2s-h-sname{display:flex;align-items:baseline;gap:6px;min-width:0;border:0;background:transparent;',
        'color:inherit;cursor:pointer;font:inherit;padding:0;}',
        '.s2s-h-stitle{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.s2s-h-scount{font-size:10px;opacity:.6;white-space:nowrap;}',
        // Every message is its OWN CARD, so consecutive turns are separable at a
        // glance. What shipped before was one thin left rule plus a near-invisible
        // `border-top` between rows, which reads as one wall of text: a divider
        // BETWEEN rows is not a boundary AROUND a message, and at `.12` alpha it
        // was barely visible even as a divider.
        //
        // The frame carries the separation rather than the fill, and that is a
        // measured decision, not a preference:
        //   - `--dsw-specific-bubble` (the framework's own message bubble) does
        //     separate in the LIGHT scheme (deepseek-50 = rgb(237,243,254) on a
        //     white panel) but is byte-identical to this panel's own surface in
        //     the DARK scheme (both bg-layer-2 and bubble resolve to
        //     bluish-850 = rgb(44,44,46)), so a fill-only card would vanish there;
        //   - the layer ladder is no help either: bg-layer-1/2/3 are all pure
        //     white in the light scheme.
        // `--dsw-alias-border-l3` IS visible in both (light rgba(0,0,0,.12) /
        // dark rgba(255,255,255,.16)), so the border is what guarantees the card
        // exists in every theme; the bubble fill is layered on top for the
        // scheme where it does help.
        '.s2s-h-msg{margin:0 10px 8px;padding:8px 10px 9px;border-radius:8px;',
        'border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));',
        'border-left-width:3px;border-left-color:transparent;',
        'background:var(--dsw-specific-bubble,rgba(128,128,128,.07));}',
        // Role is carried by the left edge, which survives the card treatment: a
        // coloured spine is what says "this turn came from another conversation".
        '.s2s-h-msg[data-role="s2s"]{border-left-color:#7aa2ff;background:rgba(122,162,255,.13);}',
        '.s2s-h-mhead{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:10.5px;opacity:.75;}',
        '.s2s-h-role{border-radius:3px;padding:0 5px;font-size:10px;background:rgba(128,128,128,.22);}',
        '.s2s-h-role[data-role="s2s"]{background:rgba(122,162,255,.3);}',
        '.s2s-h-who{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;',
        'font-size:10.5px;padding:0;text-decoration:underline dotted;opacity:.9;}',
        '.s2s-h-mtext{margin-top:3px;font-size:12px;line-height:1.5;white-space:pre-wrap;',
        'word-break:break-word;max-height:7.5em;overflow:hidden;}',
        '.s2s-h-msg[data-expanded="true"] .s2s-h-mtext{max-height:none;}',
        '.s2s-h-more{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;',
        'font:inherit;font-size:10px;opacity:.75;text-decoration:underline dotted;padding:0;}',
        '.s2s-h-cut{font-size:10px;opacity:.55;margin-top:2px;}',
        '.s2s-h-filters{border-bottom:1px solid rgba(128,128,128,.14);padding-top:0;}',
        '.s2s-h-select{flex:1;min-width:0;font:inherit;font-size:11px;padding:4px 6px;border-radius:5px;',
        // A native <select> paints its popup from the element's OWN computed
        // background-color and color. The background here was a translucent
        // rgba(), which the popup cannot composite against the panel, so it
        // fell back to the UA's default (white) while the text stayed the
        // panel's light colour — the two ran together. Closed control keeps the
        // subtle translucent chrome; the popup gets OPAQUE alias-token colours.
        'border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.1);color:inherit;}',
        // The popup rows are UA-drawn, so they are styled explicitly rather
        // than inheriting: without this the selected row is unreadable in the
        // light scheme and every row blends into the default white sheet.
        '.s2s-h-select option{background:var(--dsw-alias-bg-layer-2,#fff);',
        'color:var(--dsw-alias-label-primary,#111);}',
        '.s2s-h-select option:checked{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));}',
        '.s2s-h-s2sonly{font-size:11px;white-space:nowrap;}',
      ].join('')
      document.head.appendChild(style)
    }

    /**
     * Derive the groups the panel renders.
     * @param {object} list - sessions list snapshot.
     * @param {object} workspaces - workspaces snapshot.
     * @returns {Array<object>} derived groups.
     */
    function groupsOf(list, workspaces) {
      return buildGroups(list, workspaces, {})
    }

    /**
     * Flatten display groups into the read order of the message feed.
     *
     * Ordered by NEWEST ACTIVITY FIRST, deliberately NOT in the panel's
     * grouping order. The panel groups by workspace with the current one on
     * top, which is right for "where am I" but wrong for "what is new": it
     * would spend the first batches on the workspace the user is already in,
     * while a fresh exchange in another workspace sat unread behind them. The
     * feed's whole promise is recent traffic, so recency decides the queue and
     * the workspace only ever labels a row.
     * @param {Array<object>} groups - derived groups.
     * @returns {Array<object>} session summaries with their group label.
     */
    function feedTargets(groups) {
      const targets = []
      for (const group of groups) {
        for (const session of group.sessions) {
          targets.push({
            sessionId: session.id,
            title: session.title || session.displayTitle || shortId(session.id),
            workspaceKey: group.key,
            workspaceLabel: group.label,
            updatedAt: session.updatedAt || 0,
          })
        }
      }
      targets.sort((a, b) => (b.updatedAt - a.updatedAt)
        || (String(a.sessionId) < String(b.sessionId) ? -1 : 1))
      return targets
    }

    /**
     * Plain text of one content-block list.
     *
     * Reasoning is deliberately dropped: it is not what the conversation
     * *said*, and including it would double every reply. Tool traffic is
     * collapsed to one line each so a tool-heavy turn stays readable.
     * @param {Array<object>} blocks - content blocks.
     * @returns {string} the text.
     */
    function blocksToText(blocks) {
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        } else if (block.type === 'tool-call') {
          parts.push('[tool] ' + String(block.name === undefined ? '' : block.name))
        } else if (block.type === 'tool-result') {
          const inner = blocksToText(block.content)
          if (inner !== '') parts.push('[result] ' + inner)
        } else if (block.type === 'image') {
          parts.push('[image]')
        }
      }
      return parts.filter(part => part !== '').join('\n')
    }

    /**
     * Read the s2s envelope off a delivered message.
     *
     * The host's broker and lifecycle paths both prefix the body with one
     * `[s2s message] msgId=… from=… at=…` (or `queued-at=`) line, so the sender
     * of a group-chat message is recoverable from the durable log alone — no
     * broker round-trip, and it survives a restart. `msgId=` is optional so
     * that messages persisted before it was added still parse. The sender name
     * itself may contain spaces, so the header is split on the timestamp key,
     * not on whitespace.
     * @param {string} text - full message text.
     * @returns {object|null} { msgId, from, at, replyTo, body }, or null when not s2s.
     */
    function parseS2sHeader(text) {
      if (typeof text !== 'string') return null
      const match = /^\[s2s(?:-lifecycle)? message\]\s*(?:msgId=(\S*)\s+)?from=([\s\S]*?)\s+(?:queued-)?at=(\S*)(?:\s+replyTo=(\S*))?\n?([\s\S]*)$/.exec(text)
      if (match === null) return null
      return {
        msgId: match[1] === undefined ? null : match[1],
        from: match[2],
        at: match[3],
        replyTo: match[4] === undefined ? null : match[4],
        body: match[5],
      }
    }

    /**
     * Shorten a body for the feed without hiding that it was cut.
     * @param {string} body - full message text.
     * @returns {object} { text, truncated }.
     */
    function clip(body) {
      if (typeof body !== 'string') return { text: '', truncated: false }
      if (body.length <= FEED_BODY_LIMIT) return { text: body, truncated: false }
      return { text: body.slice(0, FEED_BODY_LIMIT), truncated: true }
    }

    /**
     * Index every known conversation by id for sender-name resolution.
     *
     * A message's envelope carries whatever the SENDER chose: dsh-s2s writes the
     * resolved title when it has one and the raw session id when it does not
     * (`labelOf`), and a hand-written `from` can be anything at all. Showing a
     * bare id where a human name is available is the difference between a
     * readable group chat and a log dump, so ids that match a session in the
     * list are replaced with `title (shortId)` — the same attribution the panel
     * uses for its own rows.
     * @param {object} list - sessions list snapshot.
     * @returns {Map<string, string>} session id → display label.
     */
    function senderIndex(list) {
      const index = new Map()
      const byId = (list && list.byId) || {}
      for (const id of Object.keys(byId)) {
        const summary = byId[id]
        if (summary === undefined || summary === null) continue
        const title = summary.title || summary.displayTitle
        const label = title === undefined || title === ''
          ? shortId(id)
          : String(title) + ' (' + shortId(id) + ')'
        index.set(String(id), label)
      }
      return index
    }

    /**
     * Resolve one sender label to a known conversation.
     *
     * The envelope's `from` is written by the broker as `title ?? sessionId`,
     * and session ids appear in this deployment both with and without the
     * `session-` container prefix (the s2s title cache stores bare uuids, the
     * session list stores prefixed ids). Exact match first, then the other
     * spelling, so either form resolves to the title when one exists.
     * @param {Map<string, string>|undefined} index - sender index.
     * @param {string} from - raw sender label.
     * @returns {string|undefined} the resolved label, or undefined when unknown.
     */
    function resolveSender(index, from) {
      if (index === undefined) return undefined
      const exact = index.get(from)
      if (exact !== undefined) return exact
      const alternate = from.startsWith('session-') ? from.slice('session-'.length) : 'session-' + from
      return index.get(alternate)
    }

    /**
     * Reduce one history page's records to feed messages.
     *
     * Only append-surface `user/message` and `assistant/message` events carry
     * conversation text: replacement ops rewrite an earlier surface entry
     * rather than adding a turn, and every other event type is machinery. The
     * host's own pagination already aligns pages to those two types, so this
     * filter is the second half of one rule, not a second rule.
     * @param {Array<object>} records - SessionHistoryRecord list.
     * @param {object} meta - { sessionId, title, workspaceKey, workspaceLabel, senderIndex }.
     * @returns {Array<object>} feed messages, oldest first.
     */
    function collectMessages(records, meta) {
      const out = []
      if (!Array.isArray(records)) return out
      for (const record of records) {
        if (record === null || typeof record !== 'object') continue
        // Packed assistant delta runs are a transport compression of events
        // already carried by their assembled `assistant/message`; rendering
        // both would show every reply twice.
        if (record.type !== 'event') continue
        const event = record.event
        if (event === null || typeof event !== 'object') continue
        const role = MESSAGE_EVENT_TYPES[event.type]
        if (role === undefined) continue
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
        const data = event.data === null || typeof event.data !== 'object' ? {} : event.data
        const blocks = role === 'assistant'
          ? (data.message === null || typeof data.message !== 'object' ? undefined : data.message.content)
          : data.content
        const text = blocksToText(blocks)
        if (text === '') continue
        const source = role === 'assistant'
          ? (data.message === null || typeof data.message !== 'object' ? undefined : data.message.source)
          : data.source
        const kind = source === null || typeof source !== 'object' ? undefined : source.kind
        const envelope = kind === 'dsh-s2s' ? parseS2sHeader(text) : null
        const body = clip(envelope === null ? text : envelope.body)
        // Resolve a bare session id in `from` to its human title when the
        // sender's own label was the id (see senderIndex).
        let from = envelope === null ? null : envelope.from
        if (from !== null) {
          const known = resolveSender(meta.senderIndex, from)
          if (known !== undefined) from = known
        }
        out.push({
          key: String(meta.sessionId) + ':' + String(event.seq),
          seq: event.seq,
          time: typeof event.time === 'number' ? event.time : 0,
          role: envelope === null ? role : 's2s',
          from: from,
          text: body.text,
          truncated: body.truncated,
          sessionId: meta.sessionId,
          title: meta.title,
          workspaceKey: meta.workspaceKey,
          workspaceLabel: meta.workspaceLabel,
        })
      }
      return out
    }

    /**
     * Filter and group feed messages for rendering.
     *
     * Every level is ordered by local timestamp, newest first: groups by their
     * newest message, sessions by theirs, messages within a session likewise.
     * The request was one chronological feed, so nothing re-sorts by name or
     * registry order once timestamps are known.
     *
     * Three independent filters narrow the same reading: a keyword, one
     * workspace, and s2s-only. They compose (all must pass), and all three run
     * over everything already read — so filtering never costs a host read and
     * never changes what the reader has loaded.
     * @param {Array<object>} messages - collected messages.
     * @param {object} [options] - { query, workspaceKey, s2sOnly }.
     * @returns {Array<object>} workspace groups, each carrying session groups.
     */
    function buildFeed(messages, options) {
      const opts = options === undefined || options === null ? {} : options
      // A plain string is still accepted as the query, so callers that only
      // filter by keyword keep working with the original one-argument form.
      const query = typeof opts === 'string' ? opts : opts.query
      const workspaceKey = typeof opts === 'string' ? undefined : opts.workspaceKey
      const s2sOnly = typeof opts === 'string' ? false : Boolean(opts.s2sOnly)
      const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : ''
      const kept = messages.filter((message) => {
        if (s2sOnly && message.role !== 's2s') return false
        if (workspaceKey !== undefined && String(message.workspaceKey) !== String(workspaceKey)) return false
        if (needle === '') return true
        return String(message.text).toLocaleLowerCase().includes(needle)
          || String(message.title).toLocaleLowerCase().includes(needle)
          || String(message.from === null ? '' : message.from).toLocaleLowerCase().includes(needle)
      })

      const workspaces = new Map()
      const sessions = new Map()
      for (const message of kept) {
        const sessionKey = String(message.sessionId)
        let session = sessions.get(sessionKey)
        if (session === undefined) {
          session = {
            key: sessionKey,
            sessionId: message.sessionId,
            title: message.title,
            workspaceKey: message.workspaceKey,
            workspaceLabel: message.workspaceLabel,
            messages: [],
            newest: 0,
          }
          sessions.set(sessionKey, session)
        }
        session.messages.push(message)
        if (message.time > session.newest) session.newest = message.time
      }

      for (const session of sessions.values()) {
        session.messages.sort((a, b) => (b.time - a.time) || (b.seq - a.seq))
        const workspaceId = String(session.workspaceKey)
        let workspace = workspaces.get(workspaceId)
        if (workspace === undefined) {
          workspace = {
            key: workspaceId,
            label: session.workspaceLabel,
            sessions: [],
            newest: 0,
          }
          workspaces.set(workspaceId, workspace)
        }
        workspace.sessions.push(session)
        if (session.newest > workspace.newest) workspace.newest = session.newest
      }

      const groups = [...workspaces.values()]
      for (const workspace of groups) {
        workspace.sessions.sort((a, b) => (b.newest - a.newest)
          || (a.key < b.key ? -1 : 1))
      }
      groups.sort((a, b) => (b.newest - a.newest) || (a.key < b.key ? -1 : 1))
      return groups
    }

    /**
     * Read one batch of conversations from the host's read-only history route.
     *
     * Why not the framework's own `session.page` RPC: it pages *backwards from
     * a cursor* (`throughSeq`), and its only cursor source is a `session.follow`
     * opening frame — whose delivery path also PROMOTES the conversation, i.e.
     * resumes an Agent for a session the user is merely browsing. A passive
     * history panel must not wake conversations. The host half therefore
     * exposes a read-only route over `sessionQuery.readSession()` (the read
     * documented as validating a full log "without making it live") and this
     * function consumes it.
     *
     * The route returns the same `SessionHistoryRecord` shape `session.page`
     * does, so the extraction below stays one code path.
     * @param {Array<string>} sessionIds - durable session ids to read.
     * @param {AbortSignal|undefined} signal - caller cancellation.
     * @returns {Promise<Array<object>>} per id: { sessionId, records, failed, why }.
     */
    async function readSessions(sessionIds, signal) {
      const url = ROUTE + '?ids=' + encodeURIComponent(sessionIds.join(','))
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        ...(signal === undefined ? {} : { signal: signal }),
      })
      if (!response.ok) {
        // 404 (no such route) and 401 (the /api fence) both mean this page
        // cannot reach the host half: either it is not mounted, or the process
        // is still running the module instance it loaded before it was edited.
        // Both are deployment facts the reader can act on, and both are fixed
        // the same way, so they read as one message rather than as two errors.
        if (response.status === 404 || response.status === 401) throw new Error(HOST_ABSENT)
        throw new Error('history route HTTP ' + String(response.status))
      }
      const payload = await response.json()
      const sessions = payload === null || typeof payload !== 'object' ? undefined : payload.sessions
      if (!Array.isArray(sessions)) throw new Error('history route returned no sessions')
      return sessions
    }

    /**
     * Read a batch of conversations, oldest activity last.
     *
     * One failure must not sink the batch: a session whose log is corrupt or
     * already deleted is reported as failed and the rest still render.
     * @param {Array<object>} targets - feed targets to read, in order.
     * @param {AbortSignal|undefined} signal - caller cancellation.
     * @returns {Promise<object>} { messages, failed, read }.
     */
    async function readBatch(targets, senderIndex, signal) {
      const messages = []
      const failed = []
      let read = 0
      if (targets.length === 0) return { messages: messages, failed: failed, read: read }
      const byId = new Map(targets.map(target => [String(target.sessionId), target]))
      let results
      try {
        results = await readSessions(targets.map(target => String(target.sessionId)), signal)
      } catch (error) {
        // A transport failure belongs to the batch, not to a conversation: the
        // per-conversation list would otherwise blame every row for one outage.
        return {
          messages: messages,
          failed: targets.map(target => ({
            sessionId: target.sessionId,
            title: target.title,
            why: String(error === null || error === undefined ? 'unknown' : (error.message || error)),
          })),
          read: read,
        }
      }
      for (const result of results) {
        const meta = byId.get(String(result.sessionId))
        if (meta === undefined) continue
        if (result.failed === true) {
          failed.push({ sessionId: result.sessionId, title: meta.title, why: String(result.why || 'unreadable') })
          continue
        }
        messages.push(...collectMessages(result.records, {
          sessionId: meta.sessionId,
          title: meta.title,
          workspaceKey: meta.workspaceKey,
          workspaceLabel: meta.workspaceLabel,
          senderIndex: senderIndex,
        }))
        read += 1
      }
      return { messages: messages, failed: failed, read: read }
    }

    /**
     * The workspaces actually present in the reading, for the filter menu.
     *
     * Built from the MESSAGES, not the workspace registry: offering a workspace
     * that contributed nothing would be a filter that filters to nothing. Order
     * follows the feed's own recency order so the menu matches what is on
     * screen.
     * @param {Array<object>} messages - collected messages.
     * @returns {Array<object>} { key, label, count }, newest activity first.
     */
    function feedWorkspaces(messages) {
      const byKey = new Map()
      for (const message of messages) {
        const key = String(message.workspaceKey)
        let entry = byKey.get(key)
        if (entry === undefined) {
          entry = { key, label: message.workspaceLabel || '', count: 0, newest: 0 }
          byKey.set(key, entry)
        }
        entry.count += 1
        if (message.time > entry.newest) entry.newest = message.time
      }
      const list = [...byKey.values()]
      list.sort((a, b) => (b.newest - a.newest) || (a.key < b.key ? -1 : 1))
      return list
    }

    /**
     * Resolve the translate function for one render.
     *
     * The framework injects `t` for any entry that declares `locale:` — but
     * the locale plugin is what supplies that face, and this package is loaded
     * from `node_modules` by a deployment it does not control. Falling back to
     * the bundle's own dictionary keeps the panel readable when that seat is
     * absent, instead of crashing the whole slot with "t is not a function".
     * @param {*} injected - `props.t` as the renderer supplied it.
     * @returns {Function} a translate function that always returns a string.
     */
    function translator(injected) {
      if (typeof injected === 'function') return injected
      return (key) => zh[key] || en[key] || key
    }

    /**
     * Subscribe a component to one ObservableSnapshot source.
     *
     * `getSnapshot` is passed straight through: these sources cache their
     * snapshot object and only mint a new one on change, which is exactly the
     * identity discipline `useSyncExternalStore` requires. Reading a fresh
     * object per call here would spin forever.
     * @param {object} React - React module.
     * @param {object} source - { getSnapshot, subscribe } observable, or undefined.
     * @returns {*} the current snapshot, or undefined without a source.
     */
    function useSource(React, source) {
      const subscribe = React.useCallback((listener) => {
        if (source === undefined || typeof source.subscribe !== 'function') return () => {}
        const dispose = source.subscribe(listener)
        return typeof dispose === 'function' ? dispose : () => {}
      }, [source])
      const getSnapshot = React.useCallback(
        () => (source === undefined ? undefined : source.getSnapshot()),
        [source])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /**
     * Incremental message reader for the feed tab.
     *
     * Reading is driven by the user opening the tab rather than by mount: each
     * batch costs one host round-trip per conversation, so the panel pays for
     * the index only when someone is looking at it.
     *
     * While the tab stays open the feed re-reads the conversations it already
     * holds on a timer. Without that, a panel left open is a photograph of the
     * moment it was opened: traffic that arrives afterwards never appears, and
     * watching a conversation you are actively messaging looks exactly like the
     * plugin "not recording new messages".
     *
     * Cancellation runs through an AbortController held in a ref, and a
     * superseded run is dropped rather than appended, so an overlapping refresh
     * and paging cannot interleave into a duplicated feed.
     * @param {object} React - React module.
     * @param {Array<object>} targets - readable conversations, newest first.
     * @param {Map<string,string>} senderIndex - session id → display label.
     * @param {boolean} active - whether the feed tab is showing.
     * @returns {object} feed state plus its controls.
     */
    function useFeed(React, targets, senderIndex, active) {
      const [state, setState] = React.useState({
        messages: [], failed: [], read: 0, phase: 'idle', error: null,
      })
      // The sender-name table is read at fetch time through a ref: it is
      // derived from the live session list, and making it an effect dependency
      // would restart the whole feed whenever any conversation is renamed.
      const senderIndexRef = React.useRef(senderIndex)
      senderIndexRef.current = senderIndex
      // The list being paged is snapshotted, not read live: the session list
      // updates on every activity event, and paging a cursor through an array
      // that re-sorts underneath it would skip or duplicate conversations. A
      // fresh snapshot is taken on activation and on explicit reload.
      const runRef = React.useRef({ items: [], cursor: 0, generation: 0, busy: false })
      const abortRef = React.useRef(null)

      const reset = React.useCallback((items) => {
        const run = runRef.current
        run.items = items
        run.cursor = 0
        run.generation += 1
        run.busy = false
        if (abortRef.current !== null) abortRef.current.abort()
        abortRef.current = null
        setState({ messages: [], failed: [], read: 0, phase: 'idle', error: null })
      }, [])

      const loadMore = React.useCallback(async () => {
        const run = runRef.current
        if (run.busy) return
        const slice = run.items.slice(run.cursor, run.cursor + FEED_BATCH)
        if (slice.length === 0) return
        run.busy = true
        const generation = run.generation
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        abortRef.current = controller
        setState(previous => ({ ...previous, phase: 'loading', error: null }))
        try {
          // A real AbortSignal is passed through only when the platform has
          // one; an improvised stand-in would break the transport's own
          // signal handling rather than cancel anything.
          const result = await readBatch(slice, senderIndexRef.current,
            controller === null ? undefined : controller.signal)
          if (generation !== runRef.current.generation) return
          run.cursor += slice.length
          setState(previous => ({
            messages: previous.messages.concat(result.messages),
            failed: previous.failed.concat(result.failed),
            read: previous.read + result.read,
            phase: 'ready',
            error: null,
          }))
        } catch (error) {
          if (generation !== runRef.current.generation) return
          setState(previous => ({
            ...previous,
            phase: 'failed',
            error: String(error === null || error === undefined ? 'unknown' : (error.message || error)),
          }))
        } finally {
          if (generation === runRef.current.generation) runRef.current.busy = false
        }
      }, [])

      // The first batch is triggered by the tab becoming active, not by the
      // component mounting, so opening the index costs nothing.
      const started = React.useRef(false)
      React.useEffect(() => {
        if (!active || started.current || targets.length === 0) return
        started.current = true
        reset(targets)
        void loadMore()
      }, [active, targets, reset, loadMore])

      /**
       * Re-read the conversations already held, REPLACING their messages.
       *
       * Paging depth is preserved: the refresh covers exactly the targets the
       * feed has already loaded, so someone who paged to 24 conversations keeps
       * 24 after it. Replacement (not append) is what makes this idempotent —
       * the same message read twice must not render twice.
       */
      const refresh = React.useCallback(async () => {
        const run = runRef.current
        if (run.busy || run.cursor === 0) return
        const slice = run.items.slice(0, run.cursor)
        run.busy = true
        const generation = run.generation
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        abortRef.current = controller
        try {
          const result = await readBatch(slice, senderIndexRef.current,
            controller === null ? undefined : controller.signal)
          if (generation !== runRef.current.generation) return
          setState(previous => ({
            messages: result.messages,
            failed: result.failed,
            read: result.read,
            phase: 'ready',
            error: previous.error,
          }))
        } catch (error) {
          // A failed poll keeps the last good reading on screen. Wiping the
          // feed because one refresh failed would be worse than showing
          // slightly stale messages, and the next tick retries anyway.
          if (generation !== runRef.current.generation) return
        } finally {
          if (generation === runRef.current.generation) runRef.current.busy = false
        }
      }, [])

      // Poll while the tab is visible so arriving traffic shows up without the
      // user knowing to press refresh.
      React.useEffect(() => {
        if (!active) return undefined
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => { void refresh() }, FEED_REFRESH_MS)
        return () => { clearInterval(timer) }
      }, [active, refresh])

      const reload = React.useCallback(() => {
        reset(targets)
        started.current = true
        void loadMore()
      }, [reset, loadMore, targets])

      const remaining = Math.max(0, runRef.current.items.length - runRef.current.cursor)
      return {
        messages: state.messages,
        failed: state.failed,
        read: state.read,
        phase: state.phase,
        error: state.error,
        remaining: remaining,
        loadMore: loadMore,
        reload: reload,
      }
    }

    /**
     * The sidebar trigger and, when open, its panel.
     *
     * Open state is component state: the slot re-renders through React, so a
     * value kept outside React could never invalidate the tree. Persistence is
     * a side effect of that state, not its source of truth.
     * @param {object} props - slot props (React, t, sessions, workspaces, openSession).
     * @returns {object} element tree.
     */
    function HistoryAction(props) {
      const React = props.React
      const t = translator(props.t)

      const [open, setOpen] = React.useState(() => {
        try {
          return window.localStorage.getItem(OPEN_KEY) === '1'
        } catch (error) {
          return false
        }
      })
      React.useEffect(() => {
        try {
          window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
        } catch (error) {
          /* storage is a convenience; the panel works without it */
        }
      }, [open])

      const [showSubagents, setShowSubagents] = React.useState(() => {
        try {
          return window.localStorage.getItem(SUBAGENT_KEY) === '1'
        } catch (error) {
          return false
        }
      })
      React.useEffect(() => {
        try {
          window.localStorage.setItem(SUBAGENT_KEY, showSubagents ? '1' : '0')
        } catch (error) {
          /* storage is a convenience; the panel works without it */
        }
      }, [showSubagents])

      const list = useSource(React, props.sessions)
      const workspaces = useSource(React, props.workspaces)
      const groups = list === undefined
        ? []
        : buildGroups(list, workspaces, { showSubagents: showSubagents })
      const current = list === undefined ? undefined : list.current

      const [tab, setTab] = React.useState(() => {
        try {
          return window.localStorage.getItem(TAB_KEY) === 'messages' ? 'messages' : 'index'
        } catch (error) {
          return 'index'
        }
      })
      React.useEffect(() => {
        try {
          window.localStorage.setItem(TAB_KEY, tab)
        } catch (error) {
          /* storage is a convenience; the panel works without it */
        }
      }, [tab])

      // Targets are derived per render but fed to the reader through the
      // reader's own snapshot, so the visible conversation set can churn
      // without re-paging a cursor through a re-sorted array.
      const targets = React.useMemo(() => feedTargets(groups), [groups])
      const senders = React.useMemo(() => senderIndex(list), [list])
      const feed = useFeed(React, targets, senders, open && tab === 'messages')

      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          className: 's2s-h-action',
          title: t('action.tip'),
          'aria-label': t('action.tip'),
          onClick: () => { setOpen(value => !value) },
        }, t('action.open')),
        open
          ? React.createElement(HistoryPanel, {
            React: React,
            portal: props.portal,
            t: t,
            groups: groups,
            current: current,
            tab: tab,
            onTab: setTab,
            feed: feed,
            showSubagents: showSubagents,
            onToggleSubagents: () => { setShowSubagents(value => !value) },
            onClose: () => { setOpen(false) },
            openSession: (sessionId) => {
              props.openSession(sessionId)
              setOpen(false)
            },
          })
          : null,
      )
    }

    /**
     * The conversation menu itself.
     *
     * Rendered through `createPortal` onto `document.body`, never inside the
     * sidebar: the sidebar column gains a `backdrop-filter` whenever the
     * wallpaper plugin's glass recipe is active, and that property makes the
     * column the containing block for fixed-position descendants — an
     * un-portaled panel would be laid out against the sidebar's own width and
     * clipped by its `overflow: hidden` instead of covering the viewport.
     * Every framework overlay (Modal, Menu, HoverCard, Toast) portals the same
     * way. Without a portal seat the tree still renders in place, degraded but
     * never blank.
     * @param {object} props - panel props.
     * @returns {object} element tree.
     */
    function HistoryPanel(props) {
      const React = props.React
      const t = props.t
      const groups = props.groups || []
      const current = props.current
      const onClose = props.onClose
      const openSession = props.openSession
      const portal = props.portal
      const now = Date.now()

      // A portaled dialog is outside the slot's own subtree, so Escape has to
      // be bound to the document rather than to a wrapper's onKeyDown.
      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [onClose])

      // Group order is already resolved by buildGroups (current workspace
      // first, ungrouped last) — re-hoisting here would fight that.
      const sections = groups.map(group => section(React, t, group, current, now, openSession))

      const tree = React.createElement('div', { className: 's2s-h-root' },
        React.createElement('div', { className: 's2s-h-mask', onClick: onClose }),
        React.createElement('div', {
          className: 's2s-h-panel',
          role: 'dialog',
          'aria-label': t('panel.title'),
        },
          React.createElement('div', { className: 's2s-h-head' },
            React.createElement('div', null,
              React.createElement('div', { className: 's2s-h-title' }, t('panel.title')),
              React.createElement('div', { className: 's2s-h-sub' },
                props.tab === 'messages' ? t('tab.messages') : t('panel.subtitle')),
            ),
            React.createElement('button', {
              type: 'button',
              className: 's2s-h-close',
              'aria-label': t('panel.close'),
              onClick: onClose,
            }, '\u00d7'),
          ),
          React.createElement('div', { className: 's2s-h-tabs', role: 'tablist' },
            tabButton(React, t, 'index', props.tab, props.onTab),
            tabButton(React, t, 'messages', props.tab, props.onTab),
          ),
          props.tab === 'messages'
            ? React.createElement(FeedView, {
              React: React,
              t: t,
              feed: props.feed,
              openSession: openSession,
            })
            : React.createElement(React.Fragment, null,
              React.createElement('div', { className: 's2s-h-body' },
                sections.length === 0
                  ? React.createElement('div', { className: 's2s-h-ghead' }, t('panel.empty'))
                  : sections,
              ),
              React.createElement('div', { className: 's2s-h-foot' },
                React.createElement('label', { className: 's2s-h-toggle' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: Boolean(props.showSubagents),
                    onChange: () => { props.onToggleSubagents() },
                  }),
                  React.createElement('span', null, t('panel.showSubagents')),
                ),
                React.createElement('span', { className: 's2s-h-sort' }, t('panel.sort')),
              ),
            ),
        ),
      )

      return typeof portal === 'function' ? portal(tree, document.body) : tree
    }

    /**
     * One tab-strip button.
     * @param {object} React - React module.
     * @param {Function} t - translator.
     * @param {string} id - tab id.
     * @param {string} active - active tab id.
     * @param {Function} onTab - tab switch handler.
     * @returns {object} button element.
     */
    function tabButton(React, t, id, active, onTab) {
      return React.createElement('button', {
        key: id,
        type: 'button',
        role: 'tab',
        className: 's2s-h-tab',
        'data-active': id === active ? 'true' : 'false',
        'aria-selected': id === active ? 'true' : 'false',
        onClick: () => { onTab(id) },
      }, t(id === 'index' ? 'tab.index' : 'tab.messages'))
    }

    /**
     * The group-chat message feed: workspace > session > message.
     *
     * Every level runs newest-first on local timestamps, and each message
     * carries its sender (session name plus short id) and its own stamp, so a
     * reader can follow a cross-session exchange in one scroll instead of
     * opening conversations one by one.
     * @param {object} props - { React, t, feed, openSession }.
     * @returns {object} element tree.
     */
    function FeedView(props) {
      const React = props.React
      const t = props.t
      const feed = props.feed
      const [query, setQuery] = React.useState('')
      // '' means every workspace; a workspace key narrows to one.
      const [workspaceKey, setWorkspaceKey] = React.useState('')
      const [s2sOnly, setS2sOnly] = React.useState(false)

      const workspaces = feedWorkspaces(feed.messages)
      const groups = buildFeed(feed.messages, {
        query: query,
        workspaceKey: workspaceKey === '' ? undefined : workspaceKey,
        s2sOnly: s2sOnly,
      })
      const shown = groups.reduce((total, group) =>
        total + group.sessions.reduce((sum, session) => sum + session.messages.length, 0), 0)

      const blocks = []
      // The cap is GLOBAL, so it is declared OUTSIDE the group loop.
      //
      // It used to sit inside, which reset it once per workspace: the documented
      // "hard cap on rendered messages" of 400 therefore really meant "400 per
      // workspace", and the row count grew with the number of workspaces instead
      // of with anything the user chose. Measured against this machine's own
      // corpus (7 groups): 780 rows rendered against a cap of 400 — and the
      // footer's `capped` notice, which compares the GLOBAL total, disagreed
      // with what was actually on screen.
      let rendered = 0
      for (const group of groups) {
        const sessionBlocks = []
        for (const session of group.sessions) {
          const rows = []
          for (const message of session.messages) {
            if (rendered >= FEED_RENDER_LIMIT) break
            rendered += 1
            rows.push(React.createElement(MessageRow, {
              key: message.key,
              React: React,
              t: t,
              message: message,
              openSession: props.openSession,
            }))
          }
          if (rows.length > 0) {
            sessionBlocks.push(React.createElement('div', { className: 's2s-h-session', key: session.key },
              // The session header names WHO, and the count says how much of
              // them is below. Without it a long body run reads as one wall of
              // text with no visible seam between conversations.
              React.createElement('div', { className: 's2s-h-shead' },
                React.createElement('button', {
                  type: 'button',
                  className: 's2s-h-sname',
                  title: t('panel.hint'),
                  onClick: () => { props.openSession(session.sessionId) },
                },
                  React.createElement('span', { className: 's2s-h-stitle' }, session.title),
                  React.createElement('span', { className: 's2s-h-sid' }, shortId(session.sessionId)),
                ),
                React.createElement('span', { className: 's2s-h-scount' },
                  // Counts the rows actually below, not how many the
                  // conversation holds: once the global cap cuts a conversation
                  // short, the larger number would describe something the reader
                  // cannot see or scroll to.
                  fill(t('feed.count'), { n: rows.length })),
                React.createElement('span', { className: 's2s-h-stamp' }, localStamp(session.newest)),
              ),
              rows,
            ))
          }
          if (rendered >= FEED_RENDER_LIMIT) break
        }
        if (sessionBlocks.length > 0) {
          blocks.push(React.createElement('div', { className: 's2s-h-group', key: group.key },
            React.createElement('div', { className: 's2s-h-ghead' },
              React.createElement('span', null, group.label || t('panel.stray'))),
            sessionBlocks,
          ))
        }
      }

      const status = []
      status.push(feed.phase === 'loading'
        ? fill(t('feed.loading'), { n: Math.min(FEED_BATCH, feed.remaining) })
        : fill(t('feed.loaded'), { s: feed.read, m: feed.messages.length, n: shown }))
      // Says what actually happened to the reader: the cap hides messages that
      // passed every filter. `feed.truncated` is a different fact (one BODY was
      // cut), and reusing it here described the wrong thing.
      if (rendered < shown) status.push(fill(t('feed.capped'), { n: rendered }))

      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 's2s-h-tools' },
          React.createElement('input', {
            type: 'search',
            className: 's2s-h-search',
            placeholder: t('feed.search'),
            value: query,
            onChange: (event) => { setQuery(event.target.value) },
          }),
          React.createElement('button', {
            type: 'button',
            className: 's2s-h-btn',
            onClick: () => { exportFeed(groups, t) },
          }, t('feed.save')),
          React.createElement('button', {
            type: 'button',
            className: 's2s-h-btn',
            onClick: () => { feed.reload() },
          }, t('feed.refresh')),
        ),
        React.createElement('div', { className: 's2s-h-tools s2s-h-filters' },
          React.createElement('select', {
            className: 's2s-h-select',
            value: workspaceKey,
            title: t('feed.workspace'),
            'aria-label': t('feed.workspace'),
            onChange: (event) => { setWorkspaceKey(event.target.value) },
          },
            React.createElement('option', { value: '' },
              t('feed.allWorkspaces') + ' (' + String(feed.messages.length) + ')'),
            workspaces.map(entry => React.createElement('option', {
              key: entry.key,
              value: entry.key,
            }, (entry.label || t('panel.stray')) + ' (' + String(entry.count) + ')')),
          ),
          React.createElement('label', { className: 's2s-h-toggle s2s-h-s2sonly' },
            React.createElement('input', {
              type: 'checkbox',
              className: 's2s-h-s2sbox',
              checked: s2sOnly,
              onChange: () => { setS2sOnly(value => !value) },
            }),
            React.createElement('span', null, t('feed.s2sOnly')),
          ),
        ),
        React.createElement('div', { className: 's2s-h-body' },
          feed.error === null || feed.error === undefined
            ? null
            : React.createElement('div', { className: 's2s-h-note s2s-h-bad' },
              feed.error === HOST_ABSENT
                ? t('feed.noroute')
                : fill(t('feed.failed'), { why: feed.error })),
          feed.messages.length === 0 && feed.phase !== 'loading'
            ? React.createElement('div', { className: 's2s-h-note' },
              feed.phase === 'idle' ? t('feed.idle') : t('feed.none'))
            : blocks,
          feed.failed.length > 0
            ? React.createElement('div', { className: 's2s-h-note' },
              feed.failed.map(item => item.title + ': ' + item.why).join(' · '))
            : null,
        ),
        React.createElement('div', { className: 's2s-h-foot' },
          React.createElement('span', null, status.join(' · ')),
          feed.remaining > 0
            ? React.createElement('button', {
              type: 'button',
              className: 's2s-h-btn s2s-h-sort',
              disabled: feed.phase === 'loading',
              onClick: () => { feed.loadMore() },
            }, fill(t('feed.more'), { n: Math.min(FEED_BATCH, feed.remaining) }))
            : null,
        ),
      )
    }

    /**
     * Render one message: role badge, sender, local stamp, body.
     * @param {object} React - React module.
     * @param {Function} t - translator.
     * @param {object} message - collected message.
     * @param {Function} openSession - session jump handler.
     * @returns {object} element.
     */
    /**
     * One message row: role badge, sender, local stamp, body.
     *
     * A real component (not a render helper) because it holds the per-row
     * expand state: calling a hook-bearing function inline would attach those
     * hooks to the parent's list, and the row count changes between renders.
     * @param {object} props - { React, t, message, openSession }.
     * @returns {object} element.
     */
    function MessageRow(props) {
      const React = props.React
      const t = props.t
      const message = props.message
      const openSession = props.openSession
      const roleKey = message.role === 'user'
        ? 'feed.role.user'
        : (message.role === 'assistant' ? 'feed.role.assistant' : 'feed.role.s2s')
      const attribution = message.from === null
        ? message.title
        : fill(t('feed.from'), { who: message.from })
      // A long body is clipped by CSS, not by discarding text, so "展开全文"
      // reveals what was always there. The toggle lives on the row itself: a
      // body that tall would otherwise swallow the whole panel and hide the
      // conversation boundary below it.
      const [expanded, setExpanded] = React.useState(false)
      const long = message.text.length > FEED_BODY_PREVIEW
      return React.createElement('div', {
        className: 's2s-h-msg',
        'data-role': message.role,
        // The host's own event sequence number, unique within a conversation.
        // Exposed because "the same turn appeared twice" is otherwise not
        // externally checkable: role + stamp + text is a false key here (the
        // stamp is minute-precision, and identical text legitimately recurs
        // across turns), so a duplicate-rendering assertion needs an identity
        // that the rendering cannot forge. Same seq in two rows = one turn
        // drawn twice.
        'data-seq': String(message.seq),
        'data-expanded': expanded ? 'true' : 'false',
      },
        React.createElement('div', { className: 's2s-h-mhead' },
          React.createElement('span', { className: 's2s-h-role', 'data-role': message.role }, t(roleKey)),
          React.createElement('button', {
            type: 'button',
            className: 's2s-h-who',
            title: t('panel.hint'),
            onClick: () => { openSession(message.sessionId) },
          }, attribution),
          React.createElement('span', { className: 's2s-h-sid' }, shortId(message.sessionId)),
          React.createElement('span', { className: 's2s-h-stamp' }, localStamp(message.time)),
          long
            ? React.createElement('button', {
              type: 'button',
              className: 's2s-h-more',
              onClick: () => { setExpanded(value => !value) },
            }, expanded ? t('feed.collapse') : t('feed.expand'))
            : null,
        ),
        React.createElement('div', { className: 's2s-h-mtext' }, message.text),
        message.truncated
          ? React.createElement('div', { className: 's2s-h-cut' }, t('feed.truncated'))
          : null,
      )
    }

    /**
     * Save one reading as a downloadable JSON file.
     *
     * Exports what is ON SCREEN (the filtered groups), not everything read:
     * after narrowing to one workspace and s2s-only, saving the whole corpus
     * would hand back something other than the reading being looked at.
     * @param {Array<object>} groups - filtered workspace groups.
     * @param {Function} t - translator.
     */
    function exportFeed(groups, t) {
      try {
        const messages = []
        for (const group of groups) {
          for (const session of group.sessions) {
            for (const message of session.messages) messages.push(message)
          }
        }
        const payload = {
          exportedAt: new Date().toISOString(),
          count: messages.length,
          messages: messages.map(message => ({
            sessionId: message.sessionId,
            sessionTitle: message.title,
            workspace: message.workspaceLabel,
            role: message.role,
            from: message.from,
            seq: message.seq,
            time: message.time,
            localTime: localStamp(message.time),
            text: message.text,
          })),
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 's2s-history-' + String(Date.now()) + '.json'
        document.body.appendChild(link)
        link.click()
        link.remove()
        setTimeout(() => { URL.revokeObjectURL(url) }, 0)
      } catch (error) {
        console.warn('[dsh-s2s] export failed:', error)
      }
    }

    /**
     * Render one workspace group.
     * @param {object} React - React module.
     * @param {Function} t - translator.
     * @param {object} group - derived group.
     * @param {string|undefined} current - current session id.
     * @param {number} now - render instant.
     * @param {Function} openSession - row click handler.
     * @returns {object} section element.
     */
    function section(React, t, group, current, now, openSession) {
      const label = group.label || t('panel.stray')
      const rows = group.sessions.map((summary) => {
        const state = stateOf(summary)
        const marks = []
        if (summary.origin === 'subagent') marks.push(t('row.subagent'))
        if (summary.blank === true) marks.push(t('row.blank'))
        if (summary.id === current) marks.push(t('row.current'))
        const title = summary.title || summary.displayTitle || shortId(summary.id)
        const stamp = localStamp(summary.updatedAt)
        return React.createElement('button', {
          key: summary.id,
          type: 'button',
          className: 's2s-h-row',
          'data-current': summary.id === current ? 'true' : 'false',
          title: stamp === '' ? title : title + '  ·  ' + stamp,
          onClick: () => { openSession(summary.id) },
        },
          React.createElement('span', { className: 's2s-h-dot', 'data-state': state }),
          React.createElement('span', { className: 's2s-h-main' },
            React.createElement('span', { className: 's2s-h-t' }, title),
            React.createElement('span', { className: 's2s-h-meta' },
              React.createElement('span', { className: 's2s-h-sid' }, shortId(summary.id)),
              ageOf(summary.updatedAt || now, now),
              stamp === ''
                ? null
                : React.createElement('span', { className: 's2s-h-stamp' }, stamp),
              marks.map((mark, index) =>
                React.createElement('span', { key: mark + index, className: 's2s-h-tag' }, mark)),
            ),
          ),
        )
      })

      return React.createElement('div', { className: 's2s-h-group', key: group.key },
        React.createElement('div', { className: 's2s-h-ghead' },
          React.createElement('span', null, label),
          React.createElement('span', { className: 's2s-h-gcount' },
            fill(t('panel.count'), { n: group.sessions.length })),
          group.running > 0
            ? React.createElement('span', { className: 's2s-h-gcount' },
              fill(t('panel.running'), { n: group.running }))
            : null,
        ),
        rows,
      )
    }

    /**
     * Mount the session-history surface.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      const React = require('react')
      // The panel portals out of the sidebar; without react-dom's createPortal
      // it still renders inline (degraded, never blank).
      let portal
      try {
        const ReactDOM = require('react-dom')
        if (typeof ReactDOM.createPortal === 'function') portal = ReactDOM.createPortal
      } catch (error) {
        portal = undefined
      }
      installStyles()

      ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'dsh-s2s: dictionaries')
      const t = ctx.locale.bind(NS)

      // Both sources are the controllers' own observable snapshots, so the
      // panel tracks renames, running bits and workspace membership live.
      // A missing service degrades to an empty panel instead of throwing.
      const sessionsService = ctx.get('sessions')
      const workspacesService = ctx.get('workspaces')
      const sessionsList = sessionsService === undefined ? undefined : sessionsService.list
      const workspacesList = workspacesService === undefined ? undefined : workspacesService.list

      // The message feed reads conversation bodies from the host half's
      // read-only history route. Nothing is declared in `inject` for it: the
      // route is a plain HTTP path, not a Cordis service, and the index half
      // must keep working when the host half is not mounted. A 404 on first
      // read is reported as "host half absent" rather than as a failure.
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: SLOT_ID,
        order: 60,
        locale: NS,
        inject: () => ({
          React: React,
          portal: portal,
          sessions: sessionsList,
          workspaces: workspacesList,
          openSession: (sessionId) => {
            if (sessionsService !== undefined) sessionsService.open(sessionId)
          },
        }),
      }, HistoryAction))
    }

    exports.HistoryAction = HistoryAction
    exports.HistoryPanel = HistoryPanel
    exports.FeedView = FeedView
    exports.buildGroups = buildGroups
    exports.groupsOf = groupsOf
    exports.feedTargets = feedTargets
    exports.collectMessages = collectMessages
    exports.senderIndex = senderIndex
    exports.resolveSender = resolveSender
    exports.buildFeed = buildFeed
    exports.feedWorkspaces = feedWorkspaces
    exports.MessageRow = MessageRow
    exports.parseS2sHeader = parseS2sHeader
    exports.blocksToText = blocksToText
    exports.readBatch = readBatch
    exports.readSessions = readSessions
    exports.ROUTE = ROUTE
    exports.useFeed = useFeed
    exports.shortId = shortId
    exports.ageOf = ageOf
    exports.NS = NS
    exports.zh = zh
    exports.en = en

    exports.name = 'dsh-s2s/client'
    exports.inject = ['slots', 'sessions', 'locale', 'remote']
    exports.apply = apply