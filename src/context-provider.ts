import {readFileSync} from 'node:fs'
import {posix} from 'node:path'
import type {Node, Parser} from 'web-tree-sitter'
import treeSitter from './tree-sitter.cjs'
import type {
  ReviewContextCandidate,
  ReviewContextProvider,
  ReviewContextRequest
} from './review-context'

/** Pinned grammar identity; keep in sync with docs/AST_CONTEXT_SUPPLY_CHAIN.md. */
export const C_CONTEXT_VARIANT_ID = 'tree-sitter-c-0.24.1'

export const MAX_CONTEXT_FILE_BYTES = 256 * 1024
const MAX_EXCERPT_LINES = 40
const DEFAULT_MAX_FETCHES = 6

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

interface Sym {
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

function declaredName(node: Node): string | null {
  const fn = node.descendantsOfType('function_declarator')[0]
  const id = fn?.childForFieldName('declarator')
  return id?.type === 'identifier' ? id.text : null
}

/** Top-level function definitions and prototypes; never descends into bodies. */
function collectSymbols(node: Node, out: Sym[] = []): Sym[] {
  for (const child of node.namedChildren) {
    if (CONTAINERS.has(child.type)) {
      collectSymbols(child, out)
    } else if (
      child.type === 'function_definition' ||
      child.type === 'declaration'
    ) {
      const name = declaredName(child)
      if (name !== null) {
        out.push({
          name,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          hasBody: child.type === 'function_definition'
        })
      }
    }
  }
  return out
}

function calledNamesInHunks(
  root: Node,
  hunks: ReviewContextRequest['hunks']
): Set<string> {
  const names = new Set<string>()
  for (const call of root.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function')
    const line = call.startPosition.row + 1
    if (
      fn?.type === 'identifier' &&
      hunks.some(h => line >= h.startLine && line <= h.endLine)
    ) {
      names.add(fn.text)
    }
  }
  return names
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

/**
 * Builds C CALLS context: for calls inside changed hunks, finds the callee's
 * definition in the same file, or its declaration/definition via quoted
 * includes and the matching sibling .c file. Instances are per-PR (caches by path).
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
      if (!/\.[ch]$/.test(request.changedFile)) return []
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
      const needed = calledNamesInHunks(tree.rootNode, request.hunks)
      if (needed.size === 0) return []

      const out: ReviewContextCandidate[] = []
      const add = (
        path: string,
        file: FetchedFile,
        sym: Sym,
        distance: number
      ) => {
        const {end, excerpt} = excerptOf(file.text, sym.startLine, sym.endLine)
        if (excerpt === '' || FORBIDDEN_EXCERPT.test(excerpt)) return
        out.push({
          headSha: request.headSha,
          blobSha: file.blobSha,
          path,
          startLine: sym.startLine,
          endLine: end,
          symbolId: `c:function:${sym.name}`,
          relation: 'CALLS',
          variantId: C_CONTEXT_VARIANT_ID,
          // A prototype alone does not prove the implementation.
          status: sym.hasBody ? 'SUPPORTED' : 'PARTIAL',
          graphDistance: distance,
          provenance: `${C_CONTEXT_VARIANT_ID}:call-to-${
            sym.hasBody ? 'definition' : 'declaration'
          }`,
          excerpt
        })
        if (sym.hasBody) needed.delete(sym.name)
      }
      const resolveIn = (
        path: string,
        file: FetchedFile,
        distance: number,
        wantBody: boolean
      ) => {
        const t = options.parser.parse(file.text)
        if (t === null) return
        for (const sym of collectSymbols(t.rootNode)) {
          if (needed.has(sym.name) && (sym.hasBody || !wantBody)) {
            add(path, file, sym, distance)
          }
        }
      }

      resolveIn(request.changedFile, self, 0, true)
      const dir = posix.dirname(request.changedFile).replace(/^\.$/, '')
      for (const inc of quotedIncludes(tree.rootNode)) {
        if (needed.size === 0 || signal.aborted || out.length >= maxCandidates)
          break
        for (const base of [dir, 'include']) {
          const headerPath = safeJoin(base, inc)
          if (headerPath === null) continue
          const header = await get(headerPath)
          if (header === null) continue
          resolveIn(headerPath, header, 1, false)
          const sibling = safeJoin(
            posix.dirname(headerPath).replace(/^\.$/, ''),
            posix.basename(headerPath).replace(/\.h$/, '.c')
          )
          if (
            needed.size > 0 &&
            sibling !== null &&
            sibling !== request.changedFile
          ) {
            const impl = await get(sibling)
            if (impl !== null) resolveIn(sibling, impl, 1, true)
          }
          break
        }
      }
      return out.slice(0, maxCandidates)
    }
  }
}
