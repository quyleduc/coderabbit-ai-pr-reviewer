import {readFileSync} from 'node:fs'
import {posix} from 'node:path'
import type {Node, Parser} from 'web-tree-sitter'
import type {
  ReviewContextCandidate,
  ReviewContextProvider,
  ReviewContextRelation,
  ReviewContextRequest
} from './review-context'
import treeSitter from './tree-sitter.cjs'

/** Pinned grammar identity; keep in sync with docs/AST_CONTEXT_SUPPLY_CHAIN.md. */
export const C_CONTEXT_VARIANT_ID = 'tree-sitter-c-0.24.1'

export const MAX_CONTEXT_FILE_BYTES = 256 * 1024
const MAX_EXCERPT_LINES = 40
const DEFAULT_MAX_FETCHES = 6
const C_FAMILY_FILE = /\.(?:[ch](?:pp|xx|c)?|cc)$/i

export interface FetchedFile {
  blobSha: string
  text: string
}
/** Must return null for missing/oversized/non-file paths and honor `signal`. */
export type FileFetcher = (
  // eslint-disable-next-line no-unused-vars
  path: string,
  // eslint-disable-next-line no-unused-vars
  ref: string,
  // eslint-disable-next-line no-unused-vars
  signal: AbortSignal
) => Promise<FetchedFile | null>

export interface ContentApi {
  repos: {
    getContent(
      // eslint-disable-next-line no-unused-vars
      params: Record<string, unknown>
    ): Promise<{data: unknown}>
  }
}

/** GitHub blob reader at a pinned ref; never checks out or executes PR code. */
export function createGithubFileFetcher(
  octokit: ContentApi,
  owner: string,
  repo: string
): FileFetcher {
  return async (path, ref, signal) => {
    try {
      const {data} = (await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
        request: {signal}
      })) as {data: Record<string, unknown>}
      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        data.encoding !== 'base64' ||
        typeof data.content !== 'string' ||
        typeof data.sha !== 'string' ||
        typeof data.size !== 'number' ||
        data.size > MAX_CONTEXT_FILE_BYTES
      ) {
        return null
      }
      return {
        blobSha: data.sha,
        text: Buffer.from(data.content, 'base64').toString('utf8')
      }
    } catch {
      // 404 and transient errors both degrade to hunk-only context.
      return null
    }
  }
}

export async function loadCParser(grammarWasmPath: string): Promise<Parser> {
  const {Language, Parser: ParserImpl} = treeSitter
  await ParserImpl.init()
  const parser: Parser = new ParserImpl()
  parser.setLanguage(await Language.load(readFileSync(grammarWasmPath)))
  return parser
}

type SymKind =
  | 'function'
  | 'macro'
  | 'typedef'
  | 'type'
  | 'enum_const'
  | 'variable'

interface Sym {
  kind: SymKind
  name: string
  startLine: number
  endLine: number
  hasBody: boolean
}

const CONTAINERS = new Set([
  'translation_unit',
  'preproc_ifdef',
  'preproc_if',
  'preproc_else',
  'preproc_elif',
  'linkage_specification',
  'declaration_list'
])

function declaredFunctionName(node: Node): string | null {
  const fn = node.descendantsOfType('function_declarator')[0]
  const id = fn?.childForFieldName('declarator')
  return id?.type === 'identifier' ? id.text : null
}

function declaredVariableNames(node: Node): string[] {
  const names: string[] = []
  for (const child of node.namedChildren) {
    if (
      child.type === 'type_Descriptor' ||
      child.type === 'struct_specifier' ||
      child.type === 'enum_specifier' ||
      child.type === 'union_specifier' ||
      child.type === 'primitive_type' ||
      child.type === 'type_identifier' ||
      child.type === 'sized_type_specifier' ||
      child.type === 'storage_class_specifier' ||
      child.type === 'type_qualifier'
    ) {
      continue
    }
    if (child.type === 'identifier') {
      names.push(child.text)
    } else {
      const id = child.descendantsOfType('identifier')[0]
      if (id) names.push(id.text)
    }
  }
  return names
}

function collectEnumConstants(node: Node, out: Sym[]): void {
  const startLine = node.startPosition.row + 1
  const endLine = node.endPosition.row + 1
  for (const enumerator of node.descendantsOfType('enumerator')) {
    const nameNode =
      enumerator.childForFieldName('name') ??
      enumerator.descendantsOfType('identifier')[0]
    if (nameNode?.type === 'identifier') {
      out.push({
        kind: 'enum_const',
        name: nameNode.text,
        startLine,
        endLine,
        hasBody: true
      })
    }
  }
}

/**
 * Extracts top-level definitions and declarations (Aider / Universal Ctags style):
 * functions, object/function macros, typedefs, structs/enums/unions, enum constants,
 * and top-level global/extern variables. Never descends into function bodies.
 */
export function collectSymbols(node: Node, out: Sym[] = []): Sym[] {
  for (const child of node.namedChildren) {
    const startLine = child.startPosition.row + 1
    const endLine = child.endPosition.row + 1
    if (CONTAINERS.has(child.type)) {
      collectSymbols(child, out)
    } else if (
      child.type === 'function_definition' ||
      child.type === 'declaration'
    ) {
      const fnName = declaredFunctionName(child)
      if (fnName !== null) {
        out.push({
          kind: 'function',
          name: fnName,
          startLine,
          endLine,
          hasBody: child.type === 'function_definition'
        })
        continue
      }
      if (child.type === 'declaration') {
        const isExtern = child.children.some(
          c => c.type === 'storage_class_specifier' && c.text === 'extern'
        )
        for (const varName of declaredVariableNames(child)) {
          out.push({
            kind: 'variable',
            name: varName,
            startLine,
            endLine,
            hasBody: !isExtern
          })
        }
      }
    } else if (
      child.type === 'preproc_def' ||
      child.type === 'preproc_function_def'
    ) {
      const nameNode =
        child.childForFieldName('name') ??
        child.descendantsOfType('identifier')[0]
      if (nameNode?.type === 'identifier') {
        out.push({
          kind: 'macro',
          name: nameNode.text,
          startLine,
          endLine,
          hasBody: true
        })
      }
    } else if (child.type === 'type_definition') {
      const typeIds = child.descendantsOfType('type_identifier')
      const aliasNode = typeIds.at(-1)
      if (aliasNode) {
        out.push({
          kind: 'typedef',
          name: aliasNode.text,
          startLine,
          endLine,
          hasBody: true
        })
      }
      for (const enumNode of child.descendantsOfType('enum_specifier')) {
        collectEnumConstants(enumNode, out)
      }
    } else if (
      child.type === 'struct_specifier' ||
      child.type === 'union_specifier' ||
      child.type === 'enum_specifier'
    ) {
      const nameNode =
        child.childForFieldName('name') ??
        child.descendantsOfType('type_identifier')[0]
      const hasFields =
        child.descendantsOfType('field_declaration_list').length > 0 ||
        child.descendantsOfType('enumerator_list').length > 0
      if (nameNode && hasFields) {
        out.push({
          kind: 'type',
          name: nameNode.text,
          startLine,
          endLine,
          hasBody: true
        })
      }
      if (child.type === 'enum_specifier' && hasFields) {
        collectEnumConstants(child, out)
      }
    }
  }
  return out
}

interface HunkReferences {
  calls: Set<string>
  writes: Set<string>
  types: Set<string>
  reads: Set<string>
}

function inHunks(line: number, hunks: ReviewContextRequest['hunks']): boolean {
  return hunks.some(h => line >= h.startLine && line <= h.endLine)
}

function rootModifiedIdentifier(target: Node | null): string | null {
  let cur = target
  while (cur) {
    if (cur.type === 'identifier') return cur.text
    if (
      cur.type === 'field_expression' ||
      cur.type === 'subscript_expression' ||
      cur.type === 'pointer_expression' ||
      cur.type === 'parenthesized_expression'
    ) {
      cur = cur.namedChildren[0] ?? null
      continue
    }
    break
  }
  return null
}

/** Collects multi-relation references inside changed hunks (SCIP / Aider style). */
export function collectHunkReferences(
  root: Node,
  hunks: ReviewContextRequest['hunks']
): HunkReferences {
  const calls = new Set<string>()
  const writes = new Set<string>()
  const types = new Set<string>()
  const reads = new Set<string>()

  for (const call of root.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function')
    const line = call.startPosition.row + 1
    if (fn?.type === 'identifier' && inHunks(line, hunks)) {
      calls.add(fn.text)
    }
  }
  for (const assign of root.descendantsOfType('assignment_expression')) {
    const line = assign.startPosition.row + 1
    if (inHunks(line, hunks)) {
      const id = rootModifiedIdentifier(assign.childForFieldName('left'))
      if (id) writes.add(id)
    }
  }
  for (const update of root.descendantsOfType('update_expression')) {
    const line = update.startPosition.row + 1
    if (inHunks(line, hunks)) {
      const id = rootModifiedIdentifier(update.childForFieldName('argument'))
      if (id) writes.add(id)
    }
  }
  for (const tid of root.descendantsOfType('type_identifier')) {
    const line = tid.startPosition.row + 1
    if (inHunks(line, hunks)) types.add(tid.text)
  }
  for (const id of root.descendantsOfType('identifier')) {
    const line = id.startPosition.row + 1
    if (inHunks(line, hunks) && !calls.has(id.text)) {
      reads.add(id.text)
    }
  }

  return {calls, writes, types, reads}
}

function quotedIncludes(root: Node): string[] {
  const paths: string[] = []
  for (const inc of root.descendantsOfType('preproc_include')) {
    const p = inc.childForFieldName('path')
    if (p?.type === 'string_literal') paths.push(p.text.slice(1, -1))
  }
  return paths
}

function safeJoin(dir: string, rel: string): string | null {
  const joined = posix.normalize(dir === '' ? rel : `${dir}/${rel}`)
  return joined.startsWith('..') || joined.startsWith('/') ? null : joined
}

function headerSearchBases(changedFile: string): string[] {
  const dir = posix.dirname(changedFile).replace(/^\.$/, '')
  const parent = posix.dirname(dir).replace(/^\.$/, '')
  const bases = [dir]
  const siblingInclude = safeJoin(parent, 'include')
  if (siblingInclude && !bases.includes(siblingInclude)) {
    bases.push(siblingInclude)
  }
  if (!bases.includes('include')) bases.push('include')
  return bases
}

function siblingSourceCandidates(headerPath: string): string[] {
  const dir = posix.dirname(headerPath).replace(/^\.$/, '')
  const stem = posix.basename(headerPath).replace(/\.[ch](?:pp|xx)?$/i, '')
  const out: string[] = []
  const dirs = [dir]
  if (posix.basename(dir) === 'include') {
    const parent = posix.dirname(dir).replace(/^\.$/, '')
    const siblingSrc = safeJoin(parent, 'src')
    if (siblingSrc) dirs.push(siblingSrc)
  }
  for (const d of dirs) {
    for (const ext of ['.c', '.cpp']) {
      const p = safeJoin(d, `${stem}${ext}`)
      if (p && !out.includes(p)) out.push(p)
    }
  }
  return out
}

function excerptOf(text: string, startLine: number, endLine: number) {
  const lines = text.split(/\r\n|\r|\n/)
  const end = Math.min(endLine, startLine + MAX_EXCERPT_LINES - 1, lines.length)
  return {end, excerpt: lines.slice(startLine - 1, end).join('\n')}
}

// Mirrors the validator in review-context.ts: one bad candidate would discard all context.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_EXCERPT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export interface AstContextProviderOptions {
  parser: Parser
  fetchFile: FileFetcher
  maxFetches?: number
}

function matchSymbolRelation(
  sym: Sym,
  refs: HunkReferences
): {
  relation: ReviewContextRelation
  symbolId: string
  satisfied: boolean
} | null {
  if (sym.kind === 'function' && refs.calls.has(sym.name)) {
    return {
      relation: 'CALLS',
      symbolId: `c:function:${sym.name}`,
      satisfied: sym.hasBody
    }
  }
  if (
    sym.kind === 'macro' &&
    (refs.calls.has(sym.name) || refs.reads.has(sym.name))
  ) {
    return {
      relation: 'EXPANDS_MACRO',
      symbolId: `c:macro:${sym.name}`,
      satisfied: true
    }
  }
  if (sym.kind === 'typedef' && refs.types.has(sym.name)) {
    return {
      relation: 'ALIASES',
      symbolId: `c:type:${sym.name}`,
      satisfied: true
    }
  }
  if (
    sym.kind === 'type' &&
    (refs.types.has(sym.name) || refs.reads.has(sym.name))
  ) {
    return {
      relation: 'READS',
      symbolId: `c:type:${sym.name}`,
      satisfied: true
    }
  }
  if (sym.kind === 'enum_const' && refs.reads.has(sym.name)) {
    return {
      relation: 'READS',
      symbolId: `c:enum:${sym.name}`,
      satisfied: true
    }
  }
  if (sym.kind === 'variable') {
    if (refs.writes.has(sym.name)) {
      return {
        relation: 'WRITES',
        symbolId: `c:variable:${sym.name}`,
        satisfied: sym.hasBody
      }
    }
    if (refs.reads.has(sym.name)) {
      return {
        relation: 'READS',
        symbolId: `c:variable:${sym.name}`,
        satisfied: sym.hasBody
      }
    }
  }
  return null
}

function hasRemainingWork(refs: HunkReferences): boolean {
  return (
    refs.calls.size > 0 ||
    refs.writes.size > 0 ||
    refs.types.size > 0 ||
    refs.reads.size > 0
  )
}

function markSatisfied(sym: Sym, refs: HunkReferences): void {
  if (sym.kind === 'function' || sym.kind === 'macro') {
    refs.calls.delete(sym.name)
    refs.reads.delete(sym.name)
  } else if (sym.kind === 'typedef' || sym.kind === 'type') {
    refs.types.delete(sym.name)
  } else if (sym.kind === 'enum_const') {
    refs.reads.delete(sym.name)
  } else if (sym.kind === 'variable') {
    refs.writes.delete(sym.name)
    refs.reads.delete(sym.name)
  }
}

/**
 * Multi-relation C/C++ AST context engine (inspired by Aider repo-map,
 * Sourcegraph SCIP relations, and clangd header/source heuristics):
 * resolves CALLS, READS, WRITES, EXPANDS_MACRO, INCLUDES, and ALIASES across
 * same-file, quoted includes (including PlatformIO/ESP-IDF sibling include/src
 * layouts), sibling implementation files, and 2-hop transitive headers.
 */
export function createAstContextProvider(
  options: AstContextProviderOptions
): ReviewContextProvider {
  const maxFetches = options.maxFetches ?? DEFAULT_MAX_FETCHES
  const cache = new Map<string, Promise<FetchedFile | null>>()
  let fetches = 0

  return {
    variantId: C_CONTEXT_VARIANT_ID,
    async collectCandidates(request, signal, maxCandidates) {
      if (!C_FAMILY_FILE.test(request.changedFile)) return []
      const get = (path: string): Promise<FetchedFile | null> => {
        let hit = cache.get(path)
        if (hit === undefined) {
          if (fetches >= maxFetches || signal.aborted)
            return Promise.resolve(null)
          fetches += 1
          hit = options.fetchFile(path, request.headSha, signal)
          cache.set(path, hit)
        }
        return hit
      }

      const self = await get(request.changedFile)
      if (self === null || signal.aborted) return []
      const tree = options.parser.parse(self.text)
      if (tree === null) return []
      const refs = collectHunkReferences(tree.rootNode, request.hunks)
      if (!hasRemainingWork(refs)) return []

      const out: ReviewContextCandidate[] = []
      const addCandidate = (
        path: string,
        file: FetchedFile,
        startLine: number,
        endLine: number,
        symbolId: string,
        relation: ReviewContextRelation,
        hasBody: boolean,
        distance: number,
        provenanceSuffix: string
      ) => {
        const {end, excerpt} = excerptOf(file.text, startLine, endLine)
        if (excerpt === '' || FORBIDDEN_EXCERPT.test(excerpt)) return
        out.push({
          headSha: request.headSha,
          blobSha: file.blobSha,
          path,
          startLine,
          endLine: end,
          symbolId,
          relation,
          variantId: C_CONTEXT_VARIANT_ID,
          status: hasBody ? 'SUPPORTED' : 'PARTIAL',
          graphDistance: distance,
          provenance: `${C_CONTEXT_VARIANT_ID}:${provenanceSuffix}`,
          excerpt
        })
      }

      const resolveIn = (
        path: string,
        file: FetchedFile,
        distance: number,
        wantBodyOnly: boolean
      ): Node | null => {
        const t = options.parser.parse(file.text)
        if (t === null) return null
        for (const sym of collectSymbols(t.rootNode)) {
          if (wantBodyOnly && !sym.hasBody) continue
          // Avoid echoing a definition whose entire span already sits inside a changed hunk of the same file.
          if (
            distance === 0 &&
            request.hunks.some(
              h => sym.startLine >= h.startLine && sym.endLine <= h.endLine
            )
          ) {
            continue
          }
          const matched = matchSymbolRelation(sym, refs)
          if (!matched) continue
          addCandidate(
            path,
            file,
            sym.startLine,
            sym.endLine,
            matched.symbolId,
            matched.relation,
            sym.hasBody,
            distance,
            `${matched.relation.toLowerCase()}-${
              sym.hasBody ? 'definition' : 'declaration'
            }`
          )
          if (matched.satisfied) markSatisfied(sym, refs)
        }
        return t.rootNode
      }

      resolveIn(request.changedFile, self, 0, true)

      const bases = headerSearchBases(request.changedFile)
      const visitedHeaders = new Set<string>()
      const secondHopQueue: Array<{fromDir: string; inc: string}> = []

      for (const inc of quotedIncludes(tree.rootNode)) {
        if (
          !hasRemainingWork(refs) ||
          signal.aborted ||
          out.length >= maxCandidates
        )
          break
        for (const base of bases) {
          const headerPath = safeJoin(base, inc)
          if (headerPath === null || visitedHeaders.has(headerPath)) continue
          const header = await get(headerPath)
          if (header === null) continue
          visitedHeaders.add(headerPath)

          const headerRoot = resolveIn(headerPath, header, 1, false)
          if (headerRoot) {
            const headerDir = posix.dirname(headerPath).replace(/^\.$/, '')
            for (const nested of quotedIncludes(headerRoot)) {
              secondHopQueue.push({fromDir: headerDir, inc: nested})
            }
          }

          if (
            refs.calls.size > 0 ||
            refs.writes.size > 0 ||
            refs.reads.size > 0
          ) {
            for (const sibling of siblingSourceCandidates(headerPath)) {
              if (sibling === request.changedFile) continue
              const impl = await get(sibling)
              if (impl !== null) {
                resolveIn(sibling, impl, 1, true)
                break
              }
            }
          }
          break
        }
      }

      // 2-hop transitive headers when unresolved symbols and fetch budget remain.
      for (const hop of secondHopQueue) {
        if (
          !hasRemainingWork(refs) ||
          signal.aborted ||
          out.length >= maxCandidates
        )
          break
        for (const base of [hop.fromDir, ...bases]) {
          const headerPath = safeJoin(base, hop.inc)
          if (headerPath === null || visitedHeaders.has(headerPath)) continue
          const header = await get(headerPath)
          if (header === null) continue
          visitedHeaders.add(headerPath)
          resolveIn(headerPath, header, 2, false)
          break
        }
      }

      return out.slice(0, maxCandidates)
    }
  }
}
