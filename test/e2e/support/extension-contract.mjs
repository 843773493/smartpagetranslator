export const EXTENSION_ID = '843773493.smart-page-translator';

export const VIEW_CONTAINER_ID = 'smart-page-translator-notes';
export const NOTES_VIEW_ID = 'notes';
export const ROOT_FILES_VIEW_ID = 'smart-page-translator-root-files';
export const OPEN_NOTES_VIEW_COMMAND = `workbench.view.extension.${VIEW_CONTAINER_ID}`;
export const OPEN_EXPLORER_VIEW_COMMAND = 'workbench.view.explorer';
export const FOCUS_ROOT_FILES_VIEW_COMMAND = `${ROOT_FILES_VIEW_ID}.focus`;
export const OPEN_WITH_COMMAND = 'vscode.openWith';

export const CUSTOM_EDITORS = {
  htmlPreview: 'smartPageTranslator.htmlPreview'
};

export const COMMANDS = {
  translate: 'smartPageTranslator.translate',
  extractAstOutline: 'smartPageTranslator.extractAstOutline',
  runWithTsx: 'smartPageTranslator.runWithTsx',
  runPytest: 'smartPageTranslator.runPytest',
  browser: {
    exportLogs: 'smartPageTranslator.browser.exportLogs',
    openDevTools: 'smartPageTranslator.browser.openDevTools',
    openUrl: 'smartPageTranslator.browser.openUrl'
  },
  rootFiles: {
    addQuickPath: 'smartPageTranslator.rootFiles.addQuickPath',
    copy: 'smartPageTranslator.rootFiles.copy',
    copyPath: 'smartPageTranslator.rootFiles.copyPath',
    cut: 'smartPageTranslator.rootFiles.cut',
    delete: 'smartPageTranslator.rootFiles.delete',
    newFile: 'smartPageTranslator.rootFiles.newFile',
    newFolder: 'smartPageTranslator.rootFiles.newFolder',
    open: 'smartPageTranslator.rootFiles.open',
    paste: 'smartPageTranslator.rootFiles.paste',
    previewHtml: 'smartPageTranslator.rootFiles.previewHtml',
    refresh: 'smartPageTranslator.rootFiles.refresh',
    removeQuickPath: 'smartPageTranslator.rootFiles.removeQuickPath',
    rename: 'smartPageTranslator.rootFiles.rename',
    revealInOS: 'smartPageTranslator.rootFiles.revealInOS'
  },
  // 仅供 E2E 使用的测试接缝，不注册到 package.json 的 UI commands。
  // 改名或删除时必须同步根 AGENTS.md 和相关 spec。
  internal: {
    getLastAstOutline: 'smartPageTranslator.internal.getLastAstOutline',
    useDeterministicTranslator: 'smartPageTranslator.internal.useDeterministicTranslator'
  },
  notes: {
    deleteNote: 'smartPageTranslator.notes.deleteNote',
    deleteFolder: 'smartPageTranslator.notes.deleteFolder',
    listNotes: 'smartPageTranslator.notes.listNotes',
    newNote: 'smartPageTranslator.notes.newNote',
    newFolder: 'smartPageTranslator.notes.newFolder',
    openNote: 'smartPageTranslator.notes.openNote',
    refreshNotes: 'smartPageTranslator.notes.refreshNotes',
    renameNote: 'smartPageTranslator.notes.renameNote',
    renameFolder: 'smartPageTranslator.notes.renameFolder',
    setupNotes: 'smartPageTranslator.notes.setupNotes'
  }
};

export const REQUIRED_COMMANDS = [
  COMMANDS.translate,
  COMMANDS.extractAstOutline,
  COMMANDS.runWithTsx,
  COMMANDS.runPytest,
  COMMANDS.browser.exportLogs,
  COMMANDS.browser.openDevTools,
  COMMANDS.browser.openUrl,
  COMMANDS.rootFiles.addQuickPath,
  COMMANDS.rootFiles.copy,
  COMMANDS.rootFiles.copyPath,
  COMMANDS.rootFiles.cut,
  COMMANDS.rootFiles.delete,
  COMMANDS.rootFiles.newFile,
  COMMANDS.rootFiles.newFolder,
  COMMANDS.rootFiles.open,
  COMMANDS.rootFiles.paste,
  COMMANDS.rootFiles.previewHtml,
  COMMANDS.rootFiles.refresh,
  COMMANDS.rootFiles.removeQuickPath,
  COMMANDS.rootFiles.rename,
  COMMANDS.rootFiles.revealInOS,
  COMMANDS.notes.deleteNote,
  COMMANDS.notes.deleteFolder,
  COMMANDS.notes.listNotes,
  COMMANDS.notes.newNote,
  COMMANDS.notes.newFolder,
  COMMANDS.notes.openNote,
  COMMANDS.notes.refreshNotes,
  COMMANDS.notes.renameNote,
  COMMANDS.notes.renameFolder,
  COMMANDS.notes.setupNotes
];
