import fs from 'fs';
import path from 'path';
import type { FileEdit } from './types.js';

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

function resolveSafeFilePath(repoPath: string, relativeFilePath: string): string {
  const repoRoot = path.resolve(repoPath);
  const fullPath = path.resolve(repoRoot, relativeFilePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Blocked unsafe path: ${relativeFilePath}`);
  }

  return fullPath;
}

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

export function applyEditsToFiles(repoPath: string, edits: FileEdit[]): string[] {
  const patchErrors: string[] = [];

  for (const edit of edits) {
    if (!edit.filepath) continue;

    const fullPath = resolveSafeFilePath(repoPath, edit.filepath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(fullPath) || edit.search.trim() === '') {
      fs.writeFileSync(fullPath, edit.replace, 'utf8');
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = countOccurrences(content, edit.search);

    if (occurrences === 0) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: Exact 'search' block not found. You must match spaces and line breaks perfectly.`,
      );
      continue;
    }

    if (occurrences > 1) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: Ambiguous 'search' block. Found ${occurrences} matches. Provide a more specific block.`,
      );
      continue;
    }

    fs.writeFileSync(fullPath, content.replace(edit.search, edit.replace), 'utf8');
  }

  return patchErrors;
}

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

