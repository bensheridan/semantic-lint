import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Hunk } from "./diff.js";

/**
 * File context for rules whose answer depends on code outside the hunk (a guard, a definition).
 * A reader returns the current content of a file, or undefined when it cannot be read.
 */
export type FileReader = (file: string) => string | undefined;

// Conservative guess, not a documented API limit. Files above it are windowed, not sent whole.
export const DEFAULT_MAX_FILE_CHARS = 40_000;

const HEAD_LINES = 60; // imports, destructuring and constants usually live at the top
const START_WINDOW = 150; // lines either side of the hunk, shrunk until the file fits

export interface RenderedContext {
    text: string;
    /** True when the file was too large and only parts of it are included. */
    windowed: boolean;
}

const numbered = (lines: string[], from: number) =>
    lines.map((line, i) => `${String(from + i + 1).padStart(5)}| ${line}`);

/** Renders a file with line numbers matching the hunk's, windowed around the hunk if too large. */
export function renderFileContext(
    content: string,
    hunk: Pick<Hunk, "startLine" | "endLine">,
    maxChars: number = DEFAULT_MAX_FILE_CHARS
): RenderedContext {
    const lines = content.replace(/\n$/, "").split("\n");
    const whole = numbered(lines, 0).join("\n");
    if (whole.length <= maxChars) return { text: whole, windowed: false };

    // Keep the head of the file plus a window around the hunk, halving the window until it fits.
    for (let window = START_WINDOW; window >= 5; window = Math.floor(window / 2)) {
        const keep = new Set<number>();
        for (let i = 0; i < Math.min(HEAD_LINES, lines.length); i++) keep.add(i);
        for (let i = Math.max(0, hunk.startLine - 1 - window); i < Math.min(lines.length, hunk.endLine + window); i++) keep.add(i);

        const out: string[] = [];
        let previous = -1;
        for (const i of [...keep].sort((a, b) => a - b)) {
            if (previous !== -1 && i > previous + 1) out.push(`      ... ${i - previous - 1} line(s) omitted ...`);
            out.push(`${String(i + 1).padStart(5)}| ${lines[i]}`);
            previous = i;
        }
        if (previous < lines.length - 1) out.push(`      ... ${lines.length - 1 - previous} line(s) omitted ...`);
        const text = out.join("\n");
        if (text.length <= maxChars) return { text, windowed: true };
    }
    // Even the smallest window is over budget (very long lines): hard-cut rather than send it all.
    return { text: whole.slice(0, maxChars), windowed: true };
}

/** Reads a file as committed at `ref`. Symlinks come back as their target text, never followed. */
export function gitFileReader(repo: string | undefined, ref: string): FileReader {
    return (file) => {
        try {
            const args = [...(repo ? ["-C", repo] : []), "show", `${ref}:${file}`];
            return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        } catch {
            return undefined;
        }
    };
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Reads files from a checked-out directory. A path or symlink that resolves outside the root is
 * refused: a hostile PR could otherwise add a symlink to a local secret and have it sent to the API.
 */
export function dirFileReader(root: string): FileReader {
    const rootReal = realpathSync(root);
    return (file) => {
        try {
            if (isAbsolute(file)) return undefined;
            const target = resolve(rootReal, file);
            if (!existsSync(target)) return undefined;
            const real = realpathSync(target);
            const rel = relative(rootReal, real);
            if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
            if (statSync(real).size > MAX_FILE_BYTES) return undefined;
            return readFileSync(real, "utf8");
        } catch {
            return undefined;
        }
    };
}
