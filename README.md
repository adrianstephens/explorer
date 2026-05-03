# YAHTZE (Yet Another Hierarchical TAR and ZIP Explorer)

A VS Code extension that opens archives (and folders) in a tree-style explorer custom editor.

## Supported Files

- `.zip`
- `.jar`
- `.apk`
- `.vsix`
- `.tar`
- `.tgz`
- `.tar.gz`

## Features

- Custom editor (`zip.view`) for supported archive file types
- Column view for name, uncompressed size, compressed size, and modified time
- Multi-select support (single, Ctrl/Cmd, Shift range select)
- Drag-and-drop between entries in the explorer
- Drag files/folders from your OS into the explorer
- Inline rename (`F2`)
- Delete (`Delete` key)
- Context menu actions in the custom editor
- Explorer context command: `Reveal in Editor` for folders

## Usage

1. Open a supported archive file in VS Code.
2. VS Code uses the `ZIP Viewer` custom editor.
3. Navigate and interact with entries using click, keyboard shortcuts, context menu, and drag-and-drop.

You can also right-click a folder in the VS Code Explorer and run `Reveal in Editor`.

## Current Limitations

- Archive write operations are supported, but should still be considered early-stage.
- Complex edits on very large archives may take time while the archive is rewritten.
- Data-safety edge cases (for example abrupt termination during write) are not yet covered by recovery/rollback logic.

