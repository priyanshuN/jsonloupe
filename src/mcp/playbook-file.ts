// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// A playbook file, read the one way both Node hosts — `jsonloupe check` and the
// MCP server's run_checks — agree on, with each other and with the browser.

import { constants, open, type FileHandle } from 'node:fs/promises';
import { MAX_PLAYBOOK_BYTES } from '../playbook';

export type PlaybookFileRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'not-a-file' | 'too-large' };

/**
 * The text of a playbook file, or why it was not read. File-system errors (no
 * such file, no permission) are thrown, for the caller to word.
 *
 * - A regular file only. A FIFO or a device reports size 0, so a size check
 *   lets it through and a whole-file read then buffers until EOF — without end,
 *   for /dev/zero. Opened non-blocking, so a FIFO with no writer is refused
 *   rather than waited on.
 * - At most MAX_PLAYBOOK_BYTES + 1 bytes are ever buffered, so a file that
 *   grows after its stat is refused without being read whole.
 * - Decoded as the browser's File.text() decodes an import, which drops one
 *   leading BOM: a playbook an editor re-saved with one imports in the app, so
 *   it runs here too.
 */
export async function readPlaybookFile(path: string): Promise<PlaybookFileRead> {
  let file: FileHandle | undefined;
  try {
    // O_NONBLOCK is undefined on Windows, which has no FIFOs to wait on.
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = await file.stat();
    if (!info.isFile()) return { ok: false, reason: 'not-a-file' };
    if (info.size > MAX_PLAYBOOK_BYTES) return { ok: false, reason: 'too-large' };
    const buffer = Buffer.alloc(MAX_PLAYBOOK_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_PLAYBOOK_BYTES) return { ok: false, reason: 'too-large' };
    return { ok: true, text: new TextDecoder('utf-8').decode(buffer.subarray(0, filled)) };
  } finally {
    await file?.close().catch(() => undefined);
  }
}
