/**
 * Session discovery for the s2s seam.
 *
 * Title resolution is layered, cheapest first, and every layer is
 * capability-probed so the plugin keeps working on hosts back to
 * `0.1.0-rc.6`:
 *
 * - **L0** {@link TitleCache} — durable local cache (memory + one small JSON
 *   file), consulted synchronously. The only cross-version accelerant; works
 *   on every host.
 * - **L1** `ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])` —
 *   the host's zero-I/O listing read (0.1.7+). A rename is visible at the next
 *   durable checkpoint.
 * - **L3** `sessionQuery.readTitle(id)` — a per-session observation that loads
 *   and folds that session's whole log. This is what made an enumeration cost
 *   ~94 ms per session; kept as the fallback for hosts without the projection
 *   cache (0.1.5 and below).
 * - **L4** on-disk scan of `${DSH_HOME || ~/.dsh}/sessions` with multi-frame
 *   zstd decoding; used when `sessionQuery` is unavailable.
 *
 * Enumeration still comes from `sessionQuery.listSessions()` (or the directory
 * scan): the projection cache answers titles, not the corpus.
 *
 * Freshness: L1 answers from the host's stored projection rows, which track
 * the session's durable checkpoints rather than its every keystroke, and L0
 * holds an answer for up to {@link TITLE_TTL_MS}. A rename therefore becomes
 * visible at the next checkpoint, not mid-turn — the deliberate trade for
 * removing a per-session log read from every enumeration.
 * @module dsh-s2s/discovery
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TitleCache } from './title-cache.ts'

export interface S2sSessionInfo {
  readonly sessionId: string
  readonly title?: string
  readonly workspaceDir: string
  readonly state: 'live-idle' | 'live-busy' | 'dormant'
  readonly lastActivity?: number
  /** The session header's `origin`, when the listing could read it (T30). The
   *  host types this as `'subagent' | undefined`; FS fallback reads it from the
   *  real log header, never from the title cache. */
  readonly origin?: string
  /** T30: no TRUSTED session header could be read on the FS path (missing/
   *  corrupt/mismatched log). The target's identity is unprovable and the
   *  classifier must fail closed (`unknown`), never assume an ordinary session. */
  readonly headerUnproven?: true
}

export type S2sCandidate = Pick<S2sSessionInfo, 'sessionId' | 'title' | 'workspaceDir' | 'state'>

/**
 * How a successful resolution found its target.
 *
 * The ruling for the name-lookup fix requires the receipt to say which rule
 * answered, because two of them are *fallbacks*: a caller that asked for an
 * exact title and silently got a prefix match cannot tell an exact hit from an
 * approximation, which is exactly the overclaim I1 forbids one level removed.
 */
export type S2sMatchKind =
  /** The value matched exactly (title, or full/normalized id). */
  | 'exact'
  /** Only a `needle`-prefixed title matched, and exactly one did. */
  | 'title-prefix'
  /** Only a unique id *prefix* matched (e.g. the short id shown in listings). */
  | 'id-prefix'

/**
 * Policy class of a target under T30 (ruling 2026-10-17).
 *
 * `eligible` sessions are the default addressing universe. `archived` comes
 * from `workspaceRegistry.archivedSessionIds` (direct membership, no lineage);
 * `subagent` from the session header's `origin` field (the host's SessionHeader
 * types `origin` as `'subagent' | undefined` — there is no third value, so an
 * unexpected string is classified `unknown` defensively). When both apply,
 * archived wins.
 */
export type S2sTargetClass = 'eligible' | 'archived' | 'subagent' | 'unknown'

/** How the archive filter can fail, rendered verbatim — never collapsed to "absent". */
export type S2sArchiveFilterState =
  | { readonly state: 'available'; readonly ids: readonly string[] }
  | { readonly state: 'unavailable'; readonly reason: 'registry-absent' | 'registry-read-failed' | 'archived-session-ids-not-an-array' }

/** The workspaceRegistry shape s2s consumes, reached structurally. */
interface WorkspaceRegistryLike {
  readonly archivedSessionIds?: unknown
}

export type S2sResolveResult =
  | {
    readonly kind: 'ok'
    readonly sessionId: string
    readonly title?: string
    readonly state: S2sSessionInfo['state']
    readonly workspaceDir: string
    readonly matchedBy: S2sMatchKind
    /** T30: how the target classifies under the archive/subagent policy. */
    readonly targetClass: S2sTargetClass
    /** T30: the header origin carried through, so post-budget re-checks classify the same target. */
    readonly origin?: string
  }
  | {
    readonly kind: 'not-found'
    readonly name: string
    /** Capped, prefix-ranked suggestions (item ⑤) — never the whole corpus. */
    readonly candidates: S2sCandidate[]
    /** Size of the corpus the suggestions were drawn from, so a receipt can say "… and N more". */
    readonly totalCandidates?: number
  }
  | { readonly kind: 'ambiguous'; readonly name: string; readonly candidates: S2sCandidate[] }

interface SessionRecordLike { readonly header: { readonly id: unknown; readonly cwd?: string; readonly origin?: unknown }; readonly live: boolean }
interface SessionQueryLike {
  listSessions(): Promise<SessionRecordLike[]>
  readTitle(sessionId: unknown): Promise<{ readonly title?: string } | undefined>
}

/**
 * The host's durable projection cache (0.1.7+), reached structurally so this
 * plugin needs no dependency on the package.
 *
 * Both faces are used, mirroring what the host's own session list does
 * (`dsh-api-session-controller`: `cachedSnapshot(header) ??
 * cachedPredecessorTitle(header)`):
 *
 * - `cachedSnapshot` — the documented zero-I/O listing read of the *current*
 *   checkpoint's rows;
 * - `cachedPredecessorTitle` — a title-only block from a *predecessor*
 *   checkpoint, for the sessions whose current checkpoint carries no title row.
 *
 * Using only the first face was a real defect: every session it could not
 * answer fell through to a per-session `readTitle`, which loads and folds that
 * session's whole log (~39 ms each). Measured against a 238-session corpus that
 * was ~119 fallbacks and a 4.7 s enumeration.
 */
interface SessionProjectionCacheLike {
  cachedSnapshot(meta: unknown, keys?: readonly string[]): ProjectionView | undefined
  cachedPredecessorTitle?(meta: unknown): ProjectionView | undefined
}

/** The shared shape of both projection-cache faces. */
interface ProjectionView {
  readonly values?: { readonly title?: unknown }
}

/** Discovery service config. */
export interface S2sDiscoveryConfig {
  /** Override the `${DSH_HOME}/sessions` scan root (tests, exotic layouts). */
  readonly sessionsRoot?: string
  /** Override the title-cache file path (tests). */
  readonly cachePath?: string
  /** Injectable clock for cache-age tests. */
  readonly now?: () => number
}

/** Max concurrent title reads / log scans; bounds open FDs on a large corpus. */
const READ_CONCURRENCY = 8

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const workers = Math.min(Math.max(limit, 1), items.length)
  let next = 0
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  }))
  return results
}

export class S2sDiscoveryService extends Service {
  private queryService?: SessionQueryLike
  private projectionCache?: SessionProjectionCacheLike
  /** T30: the host's workspace registry, when this fiber can see it. */
  private workspaceRegistry?: WorkspaceRegistryLike
  /** Last registry read failure, for diagnostics — distinct reasons must survive. */
  private lastRegistryError: string | undefined
  private readonly sessionsRoot: string | undefined
  private readonly cache: TitleCache
  private readonly now: () => number
  /** In-flight full scan shared by concurrent callers; cleared as soon as it settles. */
  private inflight: Promise<S2sSessionInfo[]> | undefined
  static inject = ['agents']

  constructor(ctx: Context, config?: S2sDiscoveryConfig) {
    super(ctx, 's2sDiscovery')
    this.sessionsRoot = config?.sessionsRoot
    this.cache = new TitleCache(config?.cachePath, (error) => {
      // A denied cache write must be reported once: silently swallowing it turns
      // the whole L0 layer into a no-op and every later call re-reads the corpus.
      ctx.logger?.warn(`s2s discovery: title cache is not writable, falling back to per-call reads: ${String(error)}`)
    })
    this.now = config?.now ?? Date.now
    // Optional dependencies: bind only when the host provides them.
    ctx.inject(['sessionQuery'], (sctx) => {
      this.queryService = (sctx as unknown as { sessionQuery: SessionQueryLike }).sessionQuery
    })
    ctx.inject(['sessionProjectionCache'], (sctx) => {
      this.projectionCache = (sctx as unknown as { sessionProjectionCache: SessionProjectionCacheLike }).sessionProjectionCache
    })
    ctx.inject(['workspaceRegistry'], (sctx) => {
      this.workspaceRegistry = (sctx as unknown as { workspaceRegistry: WorkspaceRegistryLike }).workspaceRegistry
    })
  }

  /**
   * Read the archived-session id set **fresh on every call** (T30 ruling: the
   * archive state must not freeze into the 24h title cache).
   *
   * @returns the set when the filter is usable, or the precise reason it is not
   *   — the caller fail-closes on `unavailable` and must surface the reason
   *   verbatim rather than collapsing all failures into "absent".
   */
  archivedFilterState(): S2sArchiveFilterState {
    try {
      const registry = this.workspaceRegistry
      if (registry === undefined || registry === null) return { state: 'unavailable', reason: 'registry-absent' }
      const ids = registry.archivedSessionIds
      if (ids === undefined || ids === null) return { state: 'unavailable', reason: 'archived-session-ids-not-an-array' }
      if (!Array.isArray(ids)) return { state: 'unavailable', reason: 'archived-session-ids-not-an-array' }
      return { state: 'available', ids: ids.map(String) }
    } catch (error) {
      // A throwing registry read is a distinct failure from an absent one; both
      // fail closed, but the receipt must say which.
      this.lastRegistryError = String(error)
      return { state: 'unavailable', reason: 'registry-read-failed' }
    }
  }

  /**
   * Classify one target session (T30).
   *
   * Archived membership is checked first and wins over subagent (ruling §2).
   * The header `origin` type has exactly one non-undefined value (`subagent`);
   * anything else unexpected is `unknown`, never silently "eligible". A target
   * whose header could not be proven (FS path: missing/corrupt/mismatched log)
   * is ALSO `unknown` — an unreadable identity must not become a legal target.
   *
   * @param sessionId - canonical target id.
   * @param headerOrigin - the session header's `origin`, when the listing could read it.
   * @param archivedIds - the fresh archived set, when the registry answered.
   * @param headerUnproven - true when no trusted session header could be read.
   */
  classifyTarget(sessionId: string, headerOrigin: string | undefined, archivedIds: readonly string[] | undefined, headerUnproven?: boolean): S2sTargetClass {
    if (archivedIds !== undefined && archivedIds.includes(sessionId)) return 'archived'
    if (headerUnproven === true) return 'unknown'
    if (headerOrigin === undefined) return 'eligible'
    if (headerOrigin === 'subagent') return 'subagent'
    return 'unknown'
  }

  /** The durable title cache; exposed for tooling and tests. */
  titleCache(): TitleCache {
    return this.cache
  }

  /** E3: drop cached titles so the next resolve re-reads them. */
  forgetCachedTitle(sessionId: string): void {
    this.cache.forget(sessionId)
  }

  /**
   * L1: read one title from the host's projection cache (0.1.7+).
   *
   * `cachedSnapshot` is the documented zero-I/O listing read — it views stored
   * projection rows and never opens a log. It is version- and lifecycle-matched,
   * so it returns `undefined` whenever no usable row exists (including after a
   * session format change, the case that keeps L3 alive).
   *
   * @param meta - the listing header that witnesses this session's lifecycle.
   * @returns `{ title }` when a row answered (a missing title is a real answer),
   *   or `undefined` when this layer cannot answer at all.
   */
  private readTitleFromL1(meta: unknown): { title: string | undefined } | undefined {
    const projection = this.projectionCache
    if (projection === undefined || typeof projection.cachedSnapshot !== 'function') return undefined
    try {
      // Current checkpoint first, then the predecessor title — the same two
      // faces, in the same order, that the host's own session list consults.
      // Without the second, a session whose current checkpoint has no title row
      // falls all the way through to a full per-session log read.
      const snapshot = projection.cachedSnapshot(meta, ['title'])
        ?? (typeof projection.cachedPredecessorTitle === 'function' ? projection.cachedPredecessorTitle(meta) : undefined)
      if (snapshot === undefined) return undefined
      const value = snapshot.values?.title
      return { title: typeof value === 'string' && value.length > 0 ? value : undefined }
    } catch {
      return undefined // a broken cache is a miss, never a failure
    }
  }

  /**
   * Resolve one session's title as cheaply as the host allows.
   *
   * Order: L0 cache → L1 projection cache → L3 single read → L4 on-disk scan.
   * A result is retained in L0 when it came from a real read; a title-less
   * result only is when `sessionDir` is known — otherwise every later call
   * would re-read a genuinely untitled session.
   *
   * @param sessionId - exact session id.
   * @param meta - the listing header, required for L1's lifecycle match.
   * @param sessionDir - on-disk directory for the L4 fallback.
   * @param workspaceDir - listing workspace directory, retained in L0.
   * @returns the title, or undefined when no layer produced one.
   */
  private async readTitleLayered(
    sessionId: string,
    meta?: unknown,
    sessionDir?: string,
    workspaceDir?: string,
  ): Promise<string | undefined> {
    const cached = this.cache.get(sessionId, this.now()) // E1/E4
    if (cached !== undefined) return cached.title

    let title: string | undefined
    let read = false

    // L1: zero-I/O listing read.
    const fromL1 = this.readTitleFromL1(meta)
    if (fromL1 !== undefined) {
      title = fromL1.title
      read = true
    }

    // L3: single-session observation.
    const query = this.queryService
    if (!read && query !== undefined && typeof query.readTitle === 'function') {
      try {
        title = (await query.readTitle(SessionId(sessionId)))?.title
        read = true
      } catch { /* fall through to the on-disk scan */ }
    }

    // L4: read the log ourselves.
    if (!read && sessionDir !== undefined) {
      title = await this.readTitleFromFs(sessionDir)
      read = true
    }

    if (read && (title !== undefined || sessionDir !== undefined)) {
      this.cache.set(sessionId, title, this.now(), workspaceDir)
    }
    return title
  }

  liveAgent(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  async list(query?: string): Promise<S2sSessionInfo[]> {
    const needle = query?.toLowerCase()
    const infos = await this.collect()
    const filtered = needle === undefined
      ? infos
      : infos.filter(info => info.title?.toLowerCase().includes(needle) || info.sessionId.toLowerCase().includes(needle) || info.workspaceDir.toLowerCase().includes(needle))
    return filtered
  }

  async resolve(name: string | undefined, sessionId: string | undefined): Promise<S2sResolveResult> {
    // T30: read the archived set fresh on EVERY resolution — archive state must
    // not ride the 24h title cache. The classifier closes over this reading; the
    // `unknown` reason (registry absent etc.) is NOT classified here: targets
    // under an unavailable policy stay in the corpus and the tools fail closed
    // with S2S_TARGET_POLICY_UNAVAILABLE instead of pretending eligibility.
    const filter = this.archivedFilterState()
    const archivedIds = filter.state === 'available' ? filter.ids : undefined
    const classify = (info: S2sSessionInfo): S2sTargetClass => this.classifyTarget(info.sessionId, info.origin, archivedIds, info.headerUnproven)
    if (sessionId !== undefined && sessionId.length > 0) {
      // L0 fast path: a cached entry that knows its workspace answers with no
      // enumeration and no read at all. Keyed by *normalized* id so the canonical
      // and bare spellings of the same session both hit. Exact only — a prefix
      // must prove uniqueness against the corpus, which is done below.
      const wantId = normalizeId(sessionId)
      const isCanonical = sessionId.trim().toLowerCase().startsWith('session-')
      {
        const hit = this.cache.getByNormalizedId(sessionId, this.now())
        if (hit !== undefined && hit.entry.workspaceDir !== undefined) {
          // T30: the cache stores no identity fields, so this fast path cannot
          // classify. Fall through to the authoritative read — the ruling
          // forbids a cache hit from bypassing the target policy.
          const exactAuth = await this.collectById(sessionId)
          if (exactAuth !== undefined) return toOk(exactAuth, 'exact', classify)
          return { kind: 'not-found', name: sessionId, candidates: [], totalCandidates: 0 }
        }
      }
      // Fast path: an exact canonical id needs only that session's title.
      const exact = await this.collectById(sessionId)
      if (exact !== undefined) return toOk(exact, 'exact', classify)

      // Item ④: accept the bare UUID and the short id shown by `s2s_sessions`,
      // but ONLY on a unique match, and ONLY when the input is actually
      // id-shaped (isIdShaped above). A prefix that hits more than one session
      // is ambiguous, never a guess — and it must never fall through to name
      // resolution and pretend it succeeded.
      if (!isCanonical && isIdShaped(sessionId)) {
        const infos = await this.collect()
        // Compare against the normalized canonical id so an arbitrary title or
        // path can never be mistaken for one. Exact normalized match wins; only
        // then is a prefix considered.
        const exactNorm = infos.filter(info => normalizeId(info.sessionId) === wantId)
        if (exactNorm.length === 1) return toOk(exactNorm[0]!, 'exact', classify)
        if (exactNorm.length > 1) return { kind: 'ambiguous', name: sessionId, candidates: exactNorm.map(toCandidate) }
        const prefixedById = infos.filter(info => normalizeId(info.sessionId).startsWith(wantId))
        if (prefixedById.length === 1) return toOk(prefixedById[0]!, 'id-prefix', classify)
        if (prefixedById.length > 1) return { kind: 'ambiguous', name: sessionId, candidates: prefixedById.map(toCandidate) }
        return { kind: 'not-found', name: sessionId, candidates: approxCandidates(infos, wantId), totalCandidates: infos.length }
      }
    }

    // L0 cache for name addressing: the cache warms the corpus (titles come back
    // without log reads), but it can NO LONGER answer by itself — T30 requires
    // warm and cold name resolution to run the SAME priority order
    // (eligible exact → eligible prefix → excluded diagnostic), and the cache
    // holds no identity fields to classify its single owner with. The measured
    // defect shape: an archived owner cached under a title that a NEW eligible
    // session now also carries — warm resolved the archived one while cold
    // preferred the live target. The single-owner short-circuit is therefore
    // gone; the corpus pass below consumes the warm titles.
    const needle = name?.trim().toLowerCase()
    if (needle !== undefined && needle.length > 0) {
      const owners = this.cache.findByName(needle)
      if (owners.length > 1) {
        // E2: record the collision so it is not answered from cache again.
        for (const owner of owners) this.cache.markAmbiguous(owner, this.now())
      }
    }

    const infos = await this.collect()
    if (needle === undefined || needle.length === 0) return { kind: 'not-found', name: name ?? '', candidates: approxCandidates(infos, ''), totalCandidates: infos.length }
    // T30: titles match against the ELIGIBLE universe first, so an archived
    // session sharing a title cannot shadow a live target.
    const matches = infos.filter(info => info.title?.trim().toLowerCase() === needle && classify(info) === 'eligible')
    const excludedExact = infos.filter(info => info.title?.trim().toLowerCase() === needle && classify(info) !== 'eligible')
    if (matches.length > 1) {
      // E2: remember the ambiguity so the cache never resolves this name alone.
      for (const match of matches) this.cache.markAmbiguous(match.sessionId, this.now())
      return { kind: 'ambiguous', name: name ?? '', candidates: matches.map(toCandidate) }
    }
    if (matches.length === 1) return toOk(matches[0]!, 'exact', classify)

    // Item ①: exact failed. Accept ONLY a title that *starts with* the needle,
    // and only when exactly one candidate does. No arbitrary `contains` match —
    // its false-hit risk is not supported as safe by current evidence. The
    // receipt reports `matchedBy: 'title-prefix'` so the caller can tell an
    // approximation from an exact hit.
    //
    // T30 priority order is the SAME warm and cold (review blocker 2):
    //   1. eligible exact        (above)
    //   2. eligible title-prefix (here)
    //   3. excluded targets      (diagnostic identity for a stable refusal code
    //     — an excluded exact/prefix hit resolves to a refusal, never an ok), so
    //     a live session titled as a prefix of an archived one is preferred over
    //     that archived one on BOTH cache states.
    const eligiblePrefixed = infos.filter(info => info.title?.trim().toLowerCase().startsWith(needle) === true && classify(info) === 'eligible')
    if (eligiblePrefixed.length === 1) return toOk(eligiblePrefixed[0]!, 'title-prefix', classify)
    if (eligiblePrefixed.length > 1) return { kind: 'ambiguous', name: name ?? '', candidates: eligiblePrefixed.map(toCandidate) }

    const excludedPrefixed = infos.filter(info => info.title?.trim().toLowerCase().startsWith(needle) === true)
    const excludedUniverse = excludedExact.length > 0 ? excludedExact : excludedPrefixed
    if (excludedUniverse.length === 1) return toOk(excludedUniverse[0]!, excludedExact.length > 0 ? 'exact' : 'title-prefix', classify)
    if (excludedUniverse.length > 1) return { kind: 'ambiguous', name: name ?? '', candidates: excludedUniverse.map(toCandidate) }
    return { kind: 'not-found', name: name ?? '', candidates: approxCandidates(infos, needle), totalCandidates: infos.length }
  }

  /**
   * Coalesce concurrent full scans: callers arriving while a scan is in flight
   * share it instead of re-enumerating. Cleared as soon as it settles, so a
   * later call always re-reads (titles stay fresh).
   */
  private collect(): Promise<S2sSessionInfo[]> {
    const running = this.inflight
    if (running !== undefined) return running
    const run = this.collectUncached()
    this.inflight = run
    const clear = (): void => { if (this.inflight === run) this.inflight = undefined }
    run.then(clear, clear)
    return run
  }

  /** Enumerate the complete corpus: sessionQuery primary, DSH_HOME scan fallback. */
  private async collectUncached(): Promise<S2sSessionInfo[]> {
    const query = this.queryService
    if (query !== undefined && typeof query.listSessions === 'function') {
      try { return await this.collectFromQuery(query) } catch { /* fall through to FS scan */ }
    }
    return this.collectFromFs()
  }

  /**
   * One exact session id without reading every other session's title.
   *
   * "Exact" is judged on the **normalized** id (item ④): the canonical
   * `session-<uuid>` and the bare UUID address the same session, so both are
   * accepted here. Prefix matching is deliberately NOT done in this fast path —
   * proving uniqueness requires the full corpus, which `resolve()` handles.
   */
  private async collectById(sessionId: string): Promise<S2sSessionInfo | undefined> {
    const want = normalizeId(sessionId)
    const query = this.queryService
    if (query !== undefined && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        const record = records.find(entry => normalizeId(String(entry.header.id)) === want)
        if (record === undefined) return undefined
        // Use the record's own canonical id, not the caller's spelling, so the
        // returned row is always canonical.
        const canonical = String(record.header.id)
        // L1 answers from the host's projection cache; L0 may answer with no
        // enumeration at all on a repeat call (handled by resolve()).
        const title = await this.readTitleLayered(canonical, record.header, undefined, record.header.cwd)
        return toInfo(record, canonical, title, this.stateOf(canonical))
      } catch { /* fall through to the full scan */ }
    }
    const infos = await this.collect()
    return infos.find(entry => normalizeId(entry.sessionId) === want)
  }

  /**
   * Enumerate from `sessionQuery`, cheapest source first per record:
   * L0 cache → L1 projection cache → L3 per-session read.
   *
   * Titles are retained in L0 so a later call pays nothing at all, and on
   * 0.1.7+ L1 answers the first call with zero log reads.
   */
  private async collectFromQuery(query: SessionQueryLike): Promise<S2sSessionInfo[]> {
    const records = await query.listSessions()
    const titles = new Map<string, string | undefined>()
    const misses: SessionRecordLike[] = []

    for (const record of records) {
      const sessionId = String(record.header.id)
      const cached = this.cache.get(sessionId, this.now()) // E1/E4
      if (cached !== undefined) {
        titles.set(sessionId, cached.title)
        continue
      }
      const fromL1 = this.readTitleFromL1(record.header)
      if (fromL1 !== undefined) {
        // A title-less row is a real answer, not a miss.
        titles.set(sessionId, fromL1.title)
        this.cache.set(sessionId, fromL1.title, this.now(), record.header.cwd)
        continue
      }
      misses.push(record)
    }

    return mapLimit(records, READ_CONCURRENCY, async (record): Promise<S2sSessionInfo> => {
      const sessionId = String(record.header.id)
      if (titles.has(sessionId)) {
        return toInfo(record, sessionId, titles.get(sessionId), this.stateOf(sessionId))
      }
      // L3: a single-session observation. The only path on hosts without the
      // projection cache (0.1.5 and below), and the fallback on 0.1.7+ when no
      // cached row exists yet for this session.
      const title = await this.readTitleLayered(sessionId, record.header, undefined, record.header.cwd)
      return toInfo(record, sessionId, title, this.stateOf(sessionId))
    })
  }

  private async collectFromFs(): Promise<S2sSessionInfo[]> {
    const home = process.env.DSH_HOME || process.env.DSH_DATA_DIR
    const root = this.sessionsRoot ?? (home ? join(home, 'sessions') : join(homedir(), '.dsh', 'sessions'))
    let level: string[] = []
    try { level = await readdir(root) } catch { level = [] }
    const targets: { workspaceDir: string; entry: string }[] = []
    for (const workspaceDir of level) {
      const dir = join(root, workspaceDir)
      let entries: string[] = []
      try { entries = await readdir(dir) } catch { continue }
      for (const entry of entries) {
        if (entry.startsWith('session-') && entry.length > 'session-'.length) targets.push({ workspaceDir, entry })
      }
    }
    return mapLimit(targets, READ_CONCURRENCY, async ({ workspaceDir, entry }): Promise<S2sSessionInfo> => {
      const sessionId = entry.slice('session-'.length)
      // L0 first: on hosts with no sessionQuery this is the whole acceleration.
      const cached = this.cache.get(sessionId, this.now())
      let title = cached?.title
      if (cached === undefined) {
        title = await this.readTitleLayered(sessionId, undefined, join(root, workspaceDir, entry), workspaceDir)
        this.cache.set(sessionId, title, this.now(), workspaceDir)
      }
      // T30: identity must come from the session's REAL header on disk — the
      // title cache stores no identity fields, and guessing from a title or the
      // directory name is exactly what the ruling forbids. The reading is
      // three-valued: an origin string, "no origin field on a PROVEN session
      // header" (an ordinary session), or `undefined` = no trusted header could
      // be read (missing/corrupt — the caller must classify `unknown`).
      const identity = await this.readOriginFromFs(join(root, workspaceDir, entry), sessionId)
      return {
        sessionId,
        ...(title === undefined ? {} : { title }),
        workspaceDir,
        state: this.stateOf(sessionId),
        ...(identity.origin === undefined ? {} : { origin: identity.origin }),
        ...(identity.headerProven ? {} : { headerUnproven: true } as { headerUnproven: true }),
      }
    })
  }

  /**
   * Read the session identity from the log on disk (T30 FS fallback).
   *
   * The real session log opens with a **top-level** header record — measured on
   * this host: `{type:"session", version, id, createdAt, cwd, parentSession,
   * isSeeded, origin, delegationDepth, agentPreset}` (the fields live on the
   * record itself, NOT under `data`). The first record must be a `session`
   * record whose id matches the directory name; anything else — missing file,
   * undecodable frame, wrong type, missing/mismatched id — is NOT a trusted
   * header, and the caller treats it as `unknown` (fail-closed) instead of
   * assuming an ordinary session.
   *
   * Search order: v4 zstd, legacy zstd, plain jsonl — a valid top-level header
   * in the newest format wins; a format whose header cannot be proven is NOT
   * silently retried against older guesses, because "no trusted header" is the
   * finding.
   *
   * @returns `{ origin, headerProven }` — `origin` is the header's origin field
   *   (undefined = ordinary session); `headerProven` false means no trusted
   *   session header was read and the identity is unknown.
   */
  private async readOriginFromFs(sessionDir: string, expectedBareId: string): Promise<{ origin: string | undefined; headerProven: boolean }> {
    const paths = [
      join(sessionDir, 'session.v4.jsonl.zstd'),
      join(sessionDir, 'session.jsonl.zstd'),
    ]
    for (const p of paths) {
      const read = await readFile(p).then(z => ({ z }), (error: unknown) => ({ error }))
      if ('error' in read) {
        // ENOENT = this format simply does not exist; trying the next format is
        // legitimate. ANY other error (EACCES, EBUSY, …) means a log EXISTS but
        // cannot be read — its identity is unprovable, and quietly falling
        // through to an older format (or to "ordinary") would turn an unreadable
        // session into a legal target.
        const code = (read.error as { code?: string } | undefined)?.code
        if (code === 'ENOENT') continue
        return { origin: undefined, headerProven: false }
      }
      const header = headerFromZstd(read.z, expectedBareId)
      return { origin: header.reading === 'unrecognized' ? undefined : header.reading.origin, headerProven: header.reading !== 'unrecognized' }
    }
    const plainRead = await readFile(join(sessionDir, 'session.jsonl'), 'utf8').then(t => ({ t }), (error: unknown) => ({ error }))
    if ('t' in plainRead) {
      const header = headerFromJsonl(plainRead.t, expectedBareId)
      return { origin: header.reading === 'unrecognized' ? undefined : header.reading.origin, headerProven: header.reading !== 'unrecognized' }
    }
    const code = (plainRead.error as { code?: string } | undefined)?.code
    if (code !== 'ENOENT') {
      // A plain log exists but could not be read — same fail-closed rule.
      return { origin: undefined, headerProven: false }
    }
    // No log at all.
    return { origin: undefined, headerProven: false }
  }

  private stateOf(sessionId: string): S2sSessionInfo['state'] {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    return agent !== undefined ? (agent.status === 'idle' ? 'live-idle' : 'live-busy') : 'dormant'
  }

  private async readTitleFromFs(sessionDir: string): Promise<string | undefined> {
    try {
      const z = await readFile(join(sessionDir, 'session.jsonl.zstd')).catch(() => undefined)
      if (z !== undefined) {
        const title = latestTitleFromZstd(z)
        if (title !== undefined) return title
      }
      const plain = await readFile(join(sessionDir, 'session.jsonl'), 'utf8').catch(() => undefined)
      if (plain !== undefined) return titleFromJsonl(plain)
    } catch {}
    return undefined
  }
}

/** Build one row from a query record + its resolved title and live state. */
function toInfo(record: SessionRecordLike, sessionId: string, title: string | undefined, state: S2sSessionInfo['state']): S2sSessionInfo {
  const rawOrigin = record.header.origin
  return {
    sessionId,
    ...(title === undefined ? {} : { title }),
    workspaceDir: record.header.cwd ?? '?',
    state,
    ...(typeof rawOrigin === 'string' ? { origin: rawOrigin } : {}),
  }
}

function toCandidate(info: S2sSessionInfo): S2sCandidate {
  return { sessionId: info.sessionId, ...(info.title === undefined ? {} : { title: info.title }), workspaceDir: info.workspaceDir, state: info.state }
}

function toOk(info: S2sSessionInfo, matchedBy: S2sMatchKind = 'exact', classify: (info: S2sSessionInfo) => S2sTargetClass): S2sResolveResult {
  // `origin` must survive into the receipt: the delivery tools re-classify the
  // target after the async budget, and they classify from THIS record — dropping
  // the field would make every post-resolve check see an ordinary session.
  return { kind: 'ok', sessionId: info.sessionId, ...(info.title === undefined ? {} : { title: info.title }), state: info.state, workspaceDir: info.workspaceDir, matchedBy, targetClass: classify(info), ...(info.origin === undefined ? {} : { origin: info.origin } as { origin: string }) }
}

/** How many approximate candidates a `not-found` receipt may carry (item ⑤). */
const NOT_FOUND_CANDIDATE_LIMIT = 8

/**
 * Normalize a session id for comparison.
 *
 * The canonical form is `session-<uuid>`; listings show a short, prefix-less id
 * (`tools.ts`'s `shortId`). Stripping the container prefix — and nothing else —
 * lets both address the same session without ever treating an arbitrary title or
 * path as an id (the ruling's explicit constraint).
 *
 * @param value - any caller-supplied id string.
 * @returns the lowercase form without the `session-` prefix.
 */
function normalizeId(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
}

/** A UUID shape, so a prefix match is only ever attempted between real ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Whether a caller-supplied `session_id` is **id-shaped** at all (item ④).
 *
 * Only three forms are accepted, and this gate runs *before* any prefix
 * matching: the canonical `session-<uuid>`, the bare UUID, and the short id the
 * listings display (a pure hex prefix of one). Without this gate any string
 * that merely happens to be a unique prefix of some session id would resolve —
 * a title fragment or a path segment could select a session, which the ruling
 * forbids ("不能把任意标题或路径当 id").
 *
 * @param raw - the caller-supplied string, untrimmed.
 * @returns true when the value may take the id-resolution path.
 */
function isIdShaped(raw: string): boolean {
  const bare = normalizeId(raw)
  if (UUID_RE.test(bare)) return true // canonical or bare uuid
  // Short form: a pure hex prefix of a uuid, at least the 8 chars that
  // `shortId()` prints. Hex-only is what keeps words and paths out: a Chinese
  // title, a workspace path or any letter-bearing fragment fails this test.
  return /^[0-9a-f][0-9a-f-]*$/.test(bare) && bare.length >= 8
}

/**
 * Choose the candidates a `not-found` receipt should show (item ⑤).
 *
 * Printing the entire corpus was itself part of the defect: on this host that is
 * 239 rows, so the one plausible answer is buried and the caller retries the
 * same name.
 *
 * Ranking is fixed and deliberately shallow, because the receipt must not imply
 * a match rule the resolver does not use:
 *
 * 1. titles that **start with** the needle — the same rule item ① resolves by;
 * 2. titles that **contain** the needle — *diagnostic only*. The ruling forbids
 *    using a contains hit for delivery (its false-hit risk is unsupported), so
 *    it may appear here as a hint and nowhere else;
 * 3. the rest of the corpus, in listing order.
 *
 * Note (1) is normally empty on this path: if exactly one title were prefixed,
 * item ① would have resolved it, and if several were, the result would be
 * `ambiguous`. It is kept because the ordering must be stated in one place, and
 * because (2) is what actually gives the stuck caller a lead.
 *
 * No similarity metric is invented: anything beyond these two explicit rules
 * would be a heuristic this evidence does not support.
 *
 * @param infos - the full authoritative corpus.
 * @param needle - the normalized query; empty means "no query to rank by".
 * @returns at most {@link NOT_FOUND_CANDIDATE_LIMIT} candidates.
 */
function approxCandidates(infos: readonly S2sSessionInfo[], needle: string): S2sCandidate[] {
  const titleOf = (info: S2sSessionInfo): string => info.title?.trim().toLowerCase() ?? ''
  const prefixed = needle.length === 0 ? [] : infos.filter(info => titleOf(info).startsWith(needle))
  const containing = needle.length === 0
    ? []
    : infos.filter(info => prefixed.includes(info) === false && titleOf(info).includes(needle))
  const seen = new Set([...prefixed, ...containing])
  const rest = infos.filter(info => seen.has(info) === false)
  return [...prefixed, ...containing, ...rest].slice(0, NOT_FOUND_CANDIDATE_LIMIT).map(toCandidate)
}

/** Zstandard frame magic, little-endian `28 B5 2F FD`. */
const ZSTD_MAGIC = 0xfd2fb528

interface ZstdFrame {
  readonly start: number
  readonly end: number
}

/**
 * Locate every complete Zstandard frame in a concatenated log without decoding
 * its blocks. Session logs are append-only: each append is its own frame, so a
 * real log holds thousands of frames.
 *
 * A structurally invalid complete frame throws (the caller degrades to "no
 * title"); EOF inside the final frame returns its start as `tornStart` and
 * stops, so a crash-truncated log still yields every frame written before it.
 *
 * @param buf - the complete bytes currently on disk.
 * @returns complete frame ranges, plus the start of an optional incomplete tail.
 */
function scanZstdFrames(buf: Buffer): { frames: ZstdFrame[]; tornStart?: number } {
  const frames: ZstdFrame[] = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start }
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Latest `session/title` over a concatenated-zstd log (append-only
 * multi-frame), or undefined when the log is absent, empty, corrupt, or has no
 * title event.
 *
 * Frames are decoded one at a time and only the latest title is retained, so a
 * large log never materializes as one giant string. A single frame failing to
 * decode throws (the caller falls back to "no title"), matching the previous
 * all-or-nothing behavior.
 */
function latestTitleFromZstd(buf: Buffer): string | undefined {
  const { frames } = scanZstdFrames(buf)
  let title: string | undefined
  for (const frame of frames) {
    const text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8')
    const found = titleFromJsonl(text)
    if (found !== undefined) title = found
  }
  return title
}

/** Latest `session/title` title over one frame of JSONL; undefined if none. */
function titleFromJsonl(text: string): string | undefined {
  let title: string | undefined
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try { const event = JSON.parse(line) as { type?: string; data?: { title?: unknown } }; if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.length > 0) title = event.data.title } catch {}
  }
  return title
}

/**
 * The trusted session header, read from the first record of a log (T30).
 *
 * Measured real shape (top-level fields, no `data` wrapper):
 * `{type:"session", version, id, createdAt, cwd, parentSession, isSeeded,
 *   origin, delegationDepth, agentPreset}`. `origin` is present only for
 * subagent-origin sessions.
 */
interface S2sSessionHeaderReading {
  /** The header's origin field; undefined on an ordinary (non-subagent) session. */
  readonly origin: string | undefined
  /** The header's own id — must match the directory the log was found in. */
  readonly id: string
}

/**
 * Extract and VERIFY the top-level session header from one frame of JSONL.
 *
 * Verification is decided by the FIRST NON-EMPTY record alone: it must be a
 * `session` record, carry an id, and that id must equal the expected bare id
 * (the directory name). A first record that fails to parse, carries the wrong
 * type, or mismatches the id ends the search — a LATER well-formed `session`
 * record cannot rescue an identity whose header was unreadable (an impostor
 * line must not revive it). `data.origin` is deliberately NOT consulted:
 * identity lives on the record itself. An `origin` that is present but not a
 * non-empty string is UNRECOGNIZED (unknown), never "field absent".
 *
 * @returns the trusted reading, or `'unrecognized'` when the identity could not
 *   be proven from this frame.
 */
export function headerFromJsonl(text: string, expectedBareId: string): { reading: S2sSessionHeaderReading | 'unrecognized' } {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event: { type?: unknown; id?: unknown; origin?: unknown }
    try { event = JSON.parse(line) } catch { return { reading: 'unrecognized' } }
    if (event.type !== 'session') return { reading: 'unrecognized' }
    if (typeof event.id !== 'string' || normalizeId(event.id) !== expectedBareId) return { reading: 'unrecognized' }
    if (event.origin === undefined) return { reading: { origin: undefined, id: event.id } }
    if (typeof event.origin !== 'string' || event.origin.length === 0) return { reading: 'unrecognized' }
    return { reading: { origin: event.origin, id: event.id } }
  }
  // Empty log: nothing proven.
  return { reading: 'unrecognized' }
}

/**
 * `headerFromJsonl` over a concatenated-zstd log, decided by the FIRST
 * decodable frame — later frames cannot revive a header the first one failed to
 * prove.
 */
export function headerFromZstd(buf: Buffer, expectedBareId: string): { reading: S2sSessionHeaderReading | 'unrecognized' } {
  let frames: ZstdFrame[]
  try {
    frames = scanZstdFrames(buf).frames
  } catch {
    // A structurally invalid log is an UNPROVABLE header (T30 fail-closed), not
    // a crash: the caller reports the identity as unknown.
    return { reading: 'unrecognized' }
  }
  for (const frame of frames) {
    let text: string
    try { text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8') } catch { continue }
    return { reading: headerFromJsonl(text, expectedBareId).reading }
  }
  return { reading: 'unrecognized' }
}

