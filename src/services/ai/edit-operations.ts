import fs from 'fs';
import path from 'path';
import type { FileEdit } from './types.js';

/* ────────────────────────────────────────────────────────────
   JSON extraction & repair (unchanged)
   ──────────────────────────────────────────────────────────── */

export function extractJsonObject(raw: string): string {
  const text = (raw || '')
    .trim()
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
    .replace(/[\u00A0\u2028\u2029\u200B]/g, ' ');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('No JSON object found.');
}

export function repairJsonObject(raw: string): string {
  return raw
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/}\s*([\r\n]+)\s*{/g, '},$1{')
    .replace(/]\s*([\r\n]+)\s*\[/g, '],$1[')
    .replace(/"\s*([\r\n]+)\s*"/g, '",$1"')
    .trim();
}

export function parseJsonObject<T>(raw: string): T {
  const extracted = extractJsonObject(raw);

  try {
    return JSON.parse(extracted) as T;
  } catch (originalError: any) {
    const repaired = repairJsonObject(extracted);

    try {
      return JSON.parse(repaired) as T;
    } catch (repairError: any) {
      throw new Error(
        `Failed to parse model JSON. Original error: ${originalError?.message || String(originalError)}. Repaired error: ${repairError?.message || String(repairError)}.`,
      );
    }
  }
}

/* ────────────────────────────────────────────────────────────
   Path safety
   ──────────────────────────────────────────────────────────── */

function resolveSafeFilePath(repoPath: string, relativeFilePath: string): string {
  const repoRoot = path.resolve(repoPath);
  const fullPath = path.resolve(repoRoot, relativeFilePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Blocked unsafe path: ${relativeFilePath}`);
  }

  return fullPath;
}

/* ────────────────────────────────────────────────────────────
   Fuzzy matching
   ──────────────────────────────────────────────────────────── */

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
}

/**
 * Compute a similarity ratio between two strings (0-1).
 * Uses normalized Levenshtein for short strings, line-based matching for longer ones.
 */
function similarityRatio(a: string, b: string): number {
  const normA = normalizeWhitespace(a);
  const normB = normalizeWhitespace(b);

  if (normA === normB) return 1;

  // For line-based comparison (more efficient for code blocks)
  const linesA = normA.split('\n').map((l) => l.trim()).filter(Boolean);
  const linesB = normB.split('\n').map((l) => l.trim()).filter(Boolean);

  if (linesA.length === 0 || linesB.length === 0) return 0;

  let matchingLines = 0;
  for (const line of linesA) {
    if (linesB.includes(line)) matchingLines++;
  }

  return matchingLines / Math.max(linesA.length, linesB.length);
}

/**
 * Try to find a fuzzy match for the search block within the file content.
 * Returns the exact substring from the file that best matches, or null.
 */
function findFuzzyMatch(content: string, search: string, threshold = 0.85): string | null {
  const searchLines = search.split('\n');
  const contentLines = content.split('\n');
  const searchLineCount = searchLines.length;

  if (searchLineCount === 0 || contentLines.length === 0) return null;

  let bestMatch: string | null = null;
  let bestScore = threshold;

  // Slide a window of searchLineCount lines across the content
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    const score = similarityRatio(search, window);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = window;
    }

    // Also try +/- 1 line window sizes for slight misalignment
    if (i + searchLineCount + 1 <= contentLines.length) {
      const widerWindow = contentLines.slice(i, i + searchLineCount + 1).join('\n');
      const widerScore = similarityRatio(search, widerWindow);
      if (widerScore > bestScore) {
        bestScore = widerScore;
        bestMatch = widerWindow;
      }
    }

    if (searchLineCount > 1 && i + searchLineCount - 1 <= contentLines.length) {
      const narrowerWindow = contentLines.slice(i, i + searchLineCount - 1).join('\n');
      const narrowerScore = similarityRatio(search, narrowerWindow);
      if (narrowerScore > bestScore) {
        bestScore = narrowerScore;
        bestMatch = narrowerWindow;
      }
    }
  }

  return bestMatch;
}

/* ────────────────────────────────────────────────────────────
   Exact match count
   ──────────────────────────────────────────────────────────── */

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;

  let count = 0;
  let searchStartIndex = 0;

  while (true) {
    const foundIndex = content.indexOf(search, searchStartIndex);
    if (foundIndex === -1) break;

    count += 1;
    searchStartIndex = foundIndex + search.length;
  }

  return count;
}

/* ────────────────────────────────────────────────────────────
   Atomic edit application with rollback
   ──────────────────────────────────────────────────────────── */

interface FileSnapshot {
  fullPath: string;
  existed: boolean;
  content: string | null;
}

function snapshotFile(fullPath: string): FileSnapshot {
  const existed = fs.existsSync(fullPath);
  return {
    fullPath,
    existed,
    content: existed ? fs.readFileSync(fullPath, 'utf8') : null,
  };
}

function restoreSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.existed && snapshot.content !== null) {
    fs.writeFileSync(snapshot.fullPath, snapshot.content, 'utf8');
  } else if (!snapshot.existed && fs.existsSync(snapshot.fullPath)) {
    fs.unlinkSync(snapshot.fullPath);
  }
}

/* ────────────────────────────────────────────────────────────
   Hallucinated-import guard

   Catches common package-name mistakes the model makes repeatedly.
   When a known-bad import appears in an edit's new content, the
   edit is rejected with a corrective message that feeds back into
   the iteration loop so the model can fix it immediately — much
   cheaper than catching it via `npm run start` or typecheck.
   ──────────────────────────────────────────────────────────── */

interface ForbiddenImportRule {
  /** Regex that matches the hallucinated form. */
  pattern: RegExp;
  /** Short label used in the error message. */
  name: string;
  /**
   * Builder that turns the matched string into a guidance message for the
   * agent. Must include the correct replacement so the model can recover.
   */
  message: (match: string) => string;
}

const FORBIDDEN_IMPORT_RULES: ForbiddenImportRule[] = [
  {
    // "@expo/google-fonts/poppins" — scope is actually "@expo-google-fonts" (hyphen).
    pattern: /@expo\/google-fonts\/[a-z0-9-]+/gi,
    name: 'expo-google-fonts-wrong-scope',
    message: (match) => {
      const corrected = match.replace('@expo/google-fonts/', '@expo-google-fonts/');
      return `Hallucinated package import "${match}". The Expo Google Fonts scope uses a HYPHEN, not a slash. Use "${corrected}" instead. Before adding the import, make sure "${corrected.split('/').slice(0, 2).join('/')}" is in the project's package.json dependencies.`;
    },
  },
  {
    // "@expo-google-fonts/<Family>" with capitalized family (invalid path).
    pattern: /@expo-google-fonts\/[A-Z][A-Za-z0-9-]*/g,
    name: 'expo-google-fonts-capitalized-family',
    message: (match) => {
      const fixed = match.replace(/\/[A-Z][A-Za-z0-9-]*/, (s) => s.toLowerCase());
      return `Invalid package path "${match}". Expo Google Fonts family paths are always lowercase. Use "${fixed}".`;
    },
  },
];

/**
 * Scan text that will end up in a file for forbidden imports.
 * Returns one error message per rule that fires (each may describe multiple hits).
 */
function findForbiddenImports(text: string): string[] {
  if (!text) return [];
  const errors: string[] = [];
  for (const rule of FORBIDDEN_IMPORT_RULES) {
    // Regex may be global; reset lastIndex to be safe.
    rule.pattern.lastIndex = 0;
    const matches = text.match(rule.pattern);
    if (!matches || !matches.length) continue;
    const uniqueMatches = Array.from(new Set(matches));
    errors.push(uniqueMatches.map(rule.message).join(' '));
  }
  return errors;
}

/* ────────────────────────────────────────────────────────────
   Import-shape guard

   Catches the "expected default, got named" (and inverse) mismatch
   before it explodes at runtime as "Element type is invalid".

   Cheap regex-based: extracts default/named imports from the edited
   file, resolves the target module on disk (relative imports only —
   we don't try to introspect node_modules), and checks that the target
   actually exports what was imported.

   Skips when we can't decide (target not on disk, dynamic paths, etc.)
   to avoid false positives blocking the agent.
   ──────────────────────────────────────────────────────────── */

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

interface ImportUsage {
  /** Module specifier as written in the import statement. */
  from: string;
  /** Default import name if any (e.g. `Foo` in `import Foo from './foo'`). */
  defaultName: string | null;
  /** Named bindings (e.g. `['A', 'B']` in `import { A, B } from './foo'`). */
  named: string[];
}

function extractImportUsages(source: string): ImportUsage[] {
  const usages: ImportUsage[] = [];
  // Matches: import [Default,] [* as NS,] [{ A, B as C }] from 'path';
  const importRe = /import\s+([^'"\n;]+?)\s+from\s+['"]([^'"\n]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const clause = m[1].trim();
    const from = m[2].trim();

    // "* as NS" → not relevant for default/named mismatch.
    if (/^\*\s+as\s+/.test(clause)) continue;

    let defaultName: string | null = null;
    let named: string[] = [];

    // Strip named block if present: `Foo, { A, B as C }` → default "Foo", named ["A","B"]
    const namedMatch = clause.match(/\{([^}]*)\}/);
    if (namedMatch) {
      named = namedMatch[1]
        .split(',')
        .map((entry) => entry.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean)
        // "type Foo" shape (isolated modules) — drop the "type " prefix.
        .map((name) => name.replace(/^type\s+/, ''));
    }

    // Default is whatever is left of the `{`.
    const defaultPart = clause.split('{')[0].replace(/,\s*$/, '').trim();
    if (defaultPart && !defaultPart.startsWith('{')) {
      // Also skip "type Default" when isolatedModules is used.
      defaultName = defaultPart.replace(/^type\s+/, '');
    }

    if (defaultName || named.length) {
      usages.push({ from, defaultName, named });
    }
  }
  return usages;
}

interface ModuleExportShape {
  hasDefault: boolean;
  named: Set<string>;
}

function extractExportShape(source: string): ModuleExportShape {
  const shape: ModuleExportShape = { hasDefault: false, named: new Set() };

  // `export default ...`
  if (/\bexport\s+default\b/.test(source)) {
    shape.hasDefault = true;
  }

  // `export { Foo, Bar as Baz }` / `export type { X }`
  const aggRe = /export\s+(?:type\s+)?\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = aggRe.exec(source)) !== null) {
    m[1]
      .split(',')
      .forEach((entry) => {
        const parts = entry.trim().split(/\s+as\s+/);
        const name = (parts[1] || parts[0]).trim();
        if (name) shape.named.add(name);
      });
  }

  // `export const/let/var Foo`, `export function Foo`, `export class Foo`,
  // `export async function Foo`, `export interface Foo`, `export type Foo`, `export enum Foo`.
  const declRe = /export\s+(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(source)) !== null) {
    shape.named.add(m[1]);
  }

  return shape;
}

function resolveLocalModulePath(editAbsPath: string, importFrom: string): string | null {
  // Only relative imports can be resolved without a build system.
  if (!importFrom.startsWith('./') && !importFrom.startsWith('../')) return null;

  const editDir = path.dirname(editAbsPath);
  const candidateBase = path.resolve(editDir, importFrom);

  // If the path already has a known source extension, try it directly.
  const directExt = path.extname(candidateBase);
  if (directExt && SOURCE_EXTENSIONS.includes(directExt) && fs.existsSync(candidateBase)) {
    return candidateBase;
  }

  // Try <base>.<ext> then <base>/index.<ext>.
  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = candidateBase + ext;
    if (fs.existsSync(withExt)) return withExt;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const indexPath = path.join(candidateBase, 'index' + ext);
    if (fs.existsSync(indexPath)) return indexPath;
  }
  return null;
}

/**
 * Validate imports in a file against the actual export shapes of its local
 * modules. Returns one human-readable error per mismatch, with the fix.
 */
function findImportShapeMismatches(editAbsPath: string, fileContent: string): string[] {
  const errors: string[] = [];
  const usages = extractImportUsages(fileContent);

  for (const usage of usages) {
    const targetPath = resolveLocalModulePath(editAbsPath, usage.from);
    if (!targetPath) continue; // non-local or unresolved — skip.

    let targetContent: string;
    try {
      targetContent = fs.readFileSync(targetPath, 'utf8');
    } catch {
      continue;
    }

    const shape = extractExportShape(targetContent);

    // Case 1: default import, target has no default export.
    if (usage.defaultName && !shape.hasDefault) {
      const availableNamed = Array.from(shape.named);
      const matchedNamed = availableNamed.includes(usage.defaultName);
      if (matchedNamed) {
        errors.push(
          `Import mismatch in "${usage.from}": "${usage.defaultName}" is a NAMED export, not the default. Use \`import { ${usage.defaultName} } from '${usage.from}'\` instead of \`import ${usage.defaultName} from '${usage.from}'\`.`,
        );
      } else if (availableNamed.length) {
        const preview = availableNamed.slice(0, 8).join(', ');
        errors.push(
          `Import mismatch in "${usage.from}": the module has no default export. Available named exports: ${preview}${availableNamed.length > 8 ? ', …' : ''}. Switch to a named import.`,
        );
      } else {
        errors.push(
          `Import mismatch in "${usage.from}": the module has no default export and no named exports matching "${usage.defaultName}".`,
        );
      }
      continue;
    }

    // Case 2: named imports, some do not exist in the target.
    if (usage.named.length && shape.named.size > 0) {
      const missing = usage.named.filter((n) => !shape.named.has(n));
      if (missing.length) {
        // Heuristic: if exactly one missing name AND the target has a default export,
        // suggest default-import form.
        if (missing.length === 1 && shape.hasDefault) {
          errors.push(
            `Import mismatch in "${usage.from}": "${missing[0]}" is not a named export. This module has a DEFAULT export — try \`import ${missing[0]} from '${usage.from}'\`.`,
          );
        } else {
          const preview = Array.from(shape.named).slice(0, 8).join(', ');
          errors.push(
            `Import mismatch in "${usage.from}": missing named export(s) ${missing.map((n) => `"${n}"`).join(', ')}. Available: ${preview}${shape.named.size > 8 ? ', …' : ''}.`,
          );
        }
      }
    }
  }

  return errors;
}

export function applyEditsToFiles(repoPath: string, edits: FileEdit[]): string[] {
  const patchErrors: string[] = [];
  const snapshots: FileSnapshot[] = [];
  const appliedPaths: string[] = [];

  for (const edit of edits) {
    if (!edit.filepath) continue;

    if (
      typeof edit.search === 'string' &&
      typeof edit.replace === 'string' &&
      edit.search.length > 0 &&
      edit.search === edit.replace
    ) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: No-op edit (search === replace). If the file is already correct, return "edits": [] instead.`,
      );
      break;
    }

    // Guard against known hallucinated imports before touching disk.
    // Scan both `replace` (patch target) and, when fully rewriting, `search`
    // is typically empty so the new content is in `replace`.
    if (typeof edit.replace === 'string') {
      const forbiddenErrors = findForbiddenImports(edit.replace);
      if (forbiddenErrors.length > 0) {
        patchErrors.push(
          `⚠️ Error in ${edit.filepath}: forbidden import detected. ${forbiddenErrors.join(' ')}`,
        );
        break;
      }
    }

    const fullPath = resolveSafeFilePath(repoPath, edit.filepath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Snapshot before any modification
    snapshots.push(snapshotFile(fullPath));

    let wroteThisEdit = false;

    // ── Line-range edit mode ──
    if ('startLine' in edit && typeof (edit as any).startLine === 'number') {
      const lineEdit = edit as any;

      if (!fs.existsSync(fullPath)) {
        patchErrors.push(`⚠️ Error in ${edit.filepath}: File does not exist for line-range edit.`);
        break;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      const startLine = Math.max(1, lineEdit.startLine) - 1;
      const endLine = Math.min(lines.length, lineEdit.endLine || lineEdit.startLine);

      lines.splice(startLine, endLine - startLine, edit.replace);
      fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
      appliedPaths.push(fullPath);
      wroteThisEdit = true;
    } else if (!fs.existsSync(fullPath) || edit.search.trim() === '') {
      // ── New file / full replacement ──
      fs.writeFileSync(fullPath, edit.replace, 'utf8');
      appliedPaths.push(fullPath);
      wroteThisEdit = true;
    } else {
      // ── Search/replace mode ──
      const content = fs.readFileSync(fullPath, 'utf8');
      const occurrences = countOccurrences(content, edit.search);

      if (occurrences === 1) {
        fs.writeFileSync(fullPath, content.replace(edit.search, edit.replace), 'utf8');
        appliedPaths.push(fullPath);
        wroteThisEdit = true;
      } else if (occurrences > 1) {
        patchErrors.push(
          `⚠️ Error in ${edit.filepath}: Ambiguous 'search' block. Found ${occurrences} matches. Provide a more specific block.`,
        );
        break;
      } else {
        // occurrences === 0 → try fuzzy matching
        const fuzzyMatch = findFuzzyMatch(content, edit.search);

        if (fuzzyMatch) {
          const fuzzyOccurrences = countOccurrences(content, fuzzyMatch);

          if (fuzzyOccurrences === 1) {
            console.log(`🔧 Fuzzy match applied for ${edit.filepath} (exact match failed, using closest match)`);
            fs.writeFileSync(fullPath, content.replace(fuzzyMatch, edit.replace), 'utf8');
            appliedPaths.push(fullPath);
            wroteThisEdit = true;
          }
        }

        if (!wroteThisEdit) {
          // Include current file content snippet so the agent can see what's actually there
          const contentPreview = content.length > 1500
            ? content.substring(0, 1500) + '\n... (truncated)'
            : content;
          patchErrors.push(
            `⚠️ Error in ${edit.filepath}: Exact 'search' block not found (fuzzy match also failed). The file exists but its content does not match your search block.\n\nCURRENT FILE CONTENT:\n\`\`\`\n${contentPreview}\n\`\`\`\n\nRewrite your 'search' block to match the ACTUAL content above.`,
          );
          break;
        }
      }
    }

    // ── Post-write: import-shape guard ──
    // Scan the freshly written file. If an import doesn't match the target
    // module's actual exports, reject this edit so the agent fixes it before
    // wasting iterations on runtime errors.
    if (wroteThisEdit) {
      const onlyCheckSource = SOURCE_EXTENSIONS.includes(path.extname(fullPath));
      if (onlyCheckSource) {
        try {
          const writtenContent = fs.readFileSync(fullPath, 'utf8');
          const shapeErrors = findImportShapeMismatches(fullPath, writtenContent);
          if (shapeErrors.length > 0) {
            patchErrors.push(
              `⚠️ Error in ${edit.filepath}: import shape does not match target module(s). ${shapeErrors.join(' ')}`,
            );
            break;
          }
        } catch {
          // Read-back failure is non-fatal — validation service will catch real issues later.
        }
      }
    }
  }

  // ── Rollback on errors ──
  if (patchErrors.length > 0) {
    for (const snapshot of snapshots) {
      restoreSnapshot(snapshot);
    }
  }

  return patchErrors;
}

/* ────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────── */

export function getDirsToCheck(edits: FileEdit[]): string[] {
  if (!edits.length) return ['.'];

  return Array.from(
    new Set(
      edits.map((edit) => {
        const parts = edit.filepath.split('/');
        return parts.length > 1 ? parts[0] : '.';
      }),
    ),
  );
}
