# ZIP/TAR Explorer

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
- Explorer context command: `Reveal in ZIP Explorer...` for folders

## Commands

- `zip.explore`: Reveal in ZIP Explorer...
- `zip.rename`: Rename...
- `zip.delete`: Delete

## Usage

1. Open a supported archive file in VS Code.
2. VS Code uses the `ZIP Viewer` custom editor.
3. Navigate and interact with entries using click, keyboard shortcuts, context menu, and drag-and-drop.

You can also right-click a folder in the VS Code Explorer and run `Reveal in ZIP Explorer...`.

## Current Limitations

- Archive mutations are currently in-memory only.
- Writeback (`flush`) is not enabled for ZIP/TAR/TGZ documents yet.
- This means rename, delete, and drag/drop copy or move operations are not persisted to the archive file on disk.

## Development

Requirements:

- Node.js 18+
- npm
- VS Code 1.75+

Install and build:

```bash
npm install
npm run build
```

Watch mode:

```bash
npm run watch
```

Run in Extension Development Host:

1. Open this workspace in VS Code.
2. Press `F5` (Run Extension).

## Packaging

This repository includes VS Code tasks for:

- `npm: build`
- `PACKAGE` (runs `vsce package`)
- `install` (installs the generated `.vsix` locally)

## Notes

- Extension kind is `workspace`.
- Activation currently relies on the contributed custom editor and `zip` filesystem usage.
